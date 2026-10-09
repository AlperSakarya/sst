package resource

import (
	"reflect"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

func TestMicrovmVersionsToDelete(t *testing.T) {
	version := func(name, state string, minute int) microvmImageVersion {
		return microvmImageVersion{
			ImageVersion: name,
			State:        types.MicrovmImageVersionState(state),
			CreatedAt:    time.Date(2026, 10, 9, 0, minute, 0, 0, time.UTC),
		}
	}
	cases := []struct {
		name     string
		versions []microvmImageVersion
		current  string
		inUse    map[string]bool
		keep     int
		want     []string
	}{
		{
			name: "keeps the newest that built, deletes the rest oldest first",
			versions: []microvmImageVersion{
				version("1.0", "SUCCESSFUL", 1),
				version("2.0", "SUCCESSFUL", 2),
				version("3.0", "SUCCESSFUL", 3),
				version("4.0", "SUCCESSFUL", 4),
			},
			current: "4.0",
			keep:    2,
			want:    []string{"1.0", "2.0"},
		},
		{
			name: "deletes failed builds, which don't count towards keep",
			versions: []microvmImageVersion{
				version("1.0", "SUCCESSFUL", 1),
				version("2.0", "FAILED", 2),
				version("3.0", "SUCCESSFUL", 3),
			},
			current: "3.0",
			keep:    2,
			want:    []string{"2.0"},
		},
		{
			name: "keeps versions MicroVMs still run from",
			versions: []microvmImageVersion{
				version("1.0", "SUCCESSFUL", 1),
				version("2.0", "SUCCESSFUL", 2),
				version("3.0", "SUCCESSFUL", 3),
			},
			current: "3.0",
			inUse:   map[string]bool{"1.0": true},
			keep:    1,
			want:    []string{"2.0"},
		},
		{
			name: "keeps the current version even when it isn't the newest",
			versions: []microvmImageVersion{
				version("1.0", "SUCCESSFUL", 1),
				version("2.0", "SUCCESSFUL", 2),
				version("3.0", "FAILED", 3),
			},
			current: "1.0",
			keep:    1,
			want:    []string{"3.0"},
		},
		{
			name: "leaves versions that are building or being deleted",
			versions: []microvmImageVersion{
				version("1.0", "DELETING", 1),
				version("2.0", "SUCCESSFUL", 2),
				version("3.0", "IN_PROGRESS", 3),
			},
			current: "2.0",
			keep:    1,
			want:    nil,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := microvmVersionsToDelete(c.versions, c.current, c.inUse, c.keep)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}
