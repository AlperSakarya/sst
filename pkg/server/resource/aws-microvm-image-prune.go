package resource

import (
	"log/slog"
	"sort"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

// MicrovmImagePrune deletes the old versions of a Lambda MicroVM image after it's
// built. Every build adds a version, and an image can only have 50.
type MicrovmImagePrune struct {
	*AwsResource
}

type MicrovmImagePruneInputs struct {
	ImageArn     string `json:"imageArn"`
	ImageVersion string `json:"imageVersion"`
	Region       string `json:"region"`
	Keep         int    `json:"keep"`
}

type MicrovmImagePruneOutputs struct{}

func (r *MicrovmImagePrune) Create(input *MicrovmImagePruneInputs, output *CreateResult[MicrovmImagePruneOutputs]) error {
	r.prune(input)
	*output = CreateResult[MicrovmImagePruneOutputs]{ID: input.ImageArn}
	return nil
}

func (r *MicrovmImagePrune) Update(input *UpdateInput[MicrovmImagePruneInputs, MicrovmImagePruneOutputs], output *UpdateResult[MicrovmImagePruneOutputs]) error {
	r.prune(&input.News)
	*output = UpdateResult[MicrovmImagePruneOutputs]{}
	return nil
}

// prune never fails the deploy. A version it can't delete now is tried again
// after the next build.
func (r *MicrovmImagePrune) prune(input *MicrovmImagePruneInputs) {
	deleted, err := r.deleteOldVersions(input)
	if err != nil {
		slog.Warn("failed to delete old microvm image versions", "image", input.ImageArn, "err", err)
		return
	}
	slog.Info("deleted old microvm image versions", "image", input.ImageArn, "versions", deleted)
}

type microvmImageVersion struct {
	ImageVersion string
	State        types.MicrovmImageVersionState
	CreatedAt    time.Time
}

func (r *MicrovmImagePrune) deleteOldVersions(input *MicrovmImagePruneInputs) ([]string, error) {
	cfg, err := r.config()
	if err != nil {
		return nil, err
	}
	if input.Region != "" {
		cfg.Region = input.Region
	}
	client := lambdamicrovms.NewFromConfig(cfg)

	var versions []microvmImageVersion
	versionPages := lambdamicrovms.NewListMicrovmImageVersionsPaginator(client, &lambdamicrovms.ListMicrovmImageVersionsInput{
		ImageIdentifier: aws.String(input.ImageArn),
	})
	for versionPages.HasMorePages() {
		page, err := versionPages.NextPage(r.context)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			versions = append(versions, microvmImageVersion{
				ImageVersion: aws.ToString(item.ImageVersion),
				State:        item.State,
				CreatedAt:    aws.ToTime(item.CreatedAt),
			})
		}
	}

	inUse := map[string]bool{}
	microvmPages := lambdamicrovms.NewListMicrovmsPaginator(client, &lambdamicrovms.ListMicrovmsInput{
		ImageIdentifier: aws.String(input.ImageArn),
	})
	for microvmPages.HasMorePages() {
		page, err := microvmPages.NextPage(r.context)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			if item.State != types.MicrovmStateTerminated {
				inUse[aws.ToString(item.ImageVersion)] = true
			}
		}
	}

	var deleted []string
	for _, version := range microvmVersionsToDelete(versions, input.ImageVersion, inUse, input.Keep) {
		_, err := client.DeleteMicrovmImageVersion(r.context, &lambdamicrovms.DeleteMicrovmImageVersionInput{
			ImageIdentifier: aws.String(input.ImageArn),
			ImageVersion:    aws.String(version),
		})
		if err != nil {
			slog.Warn("failed to delete microvm image version", "image", input.ImageArn, "version", version, "err", err)
			continue
		}
		deleted = append(deleted, version)
	}
	return deleted, nil
}

// microvmVersionsToDelete keeps the current version, the newest `keep` versions
// that built, and every version MicroVMs still run from. It returns the rest,
// failed builds included, oldest first. Versions still building or being deleted
// are left alone.
func microvmVersionsToDelete(versions []microvmImageVersion, current string, inUse map[string]bool, keep int) []string {
	sorted := append([]microvmImageVersion{}, versions...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].CreatedAt.After(sorted[j].CreatedAt) })

	var result []string
	built := 0
	for _, v := range sorted {
		switch {
		case v.ImageVersion == current, inUse[v.ImageVersion]:
			if v.State == types.MicrovmImageVersionStateSuccessful {
				built++
			}
		case v.State == types.MicrovmImageVersionStateSuccessful:
			built++
			if built > keep {
				result = append(result, v.ImageVersion)
			}
		case v.State == types.MicrovmImageVersionStateFailed:
			result = append(result, v.ImageVersion)
		}
	}

	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result
}
