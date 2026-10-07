package npm

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/Masterminds/semver/v3"
)

// The newest of the candidates in the same major version as current, so an
// upgrade never crosses into a major with breaking changes. Prereleases count
// only when current is one. ok is false when current isn't a version, like a
// dev build.
func NewestInMajor(current string, candidates []string) (newest string, ok bool, err error) {
	v, err := semver.NewVersion(current)
	if err != nil {
		return "", false, nil
	}
	var found *semver.Version
	for _, candidate := range candidates {
		c, err := semver.NewVersion(candidate)
		if err != nil || c.Major() != v.Major() {
			continue
		}
		if c.Prerelease() != "" && v.Prerelease() == "" {
			continue
		}
		if found == nil || c.GreaterThan(found) {
			found = c
		}
	}
	if found == nil {
		return "", true, fmt.Errorf("there is no version %d.x to upgrade to", v.Major())
	}
	return found.Original(), true, nil
}

// The newest version of a package in the same major version as current. A
// current that isn't a version gets the one tagged latest.
func Newest(registry Registry, name string, current string) (string, error) {
	versions, err := Versions(registry, name)
	if err != nil {
		return "", err
	}
	newest, ok, err := NewestInMajor(current, versions)
	if ok {
		return newest, err
	}
	pkg, err := Get(registry, name, "latest")
	if err != nil {
		return "", err
	}
	return pkg.Version, nil
}

// Every published version of a package
func Versions(registry Registry, name string) ([]string, error) {
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/%s", registry.url, name), nil)
	if err != nil {
		return nil, err
	}
	// The abbreviated document, which has the versions without their readmes
	req.Header.Set("Accept", "application/vnd.npm.install-v1+json")
	if registry.auth.token != "" {
		req.Header.Set("Authorization", registry.auth.scheme+" "+registry.auth.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to fetch package: %s", resp.Status)
	}
	var data struct {
		Versions map[string]json.RawMessage `json:"versions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	versions := make([]string, 0, len(data.Versions))
	for version := range data.Versions {
		versions = append(versions, version)
	}
	return versions, nil
}
