package project

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEventLogRestarted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "eventlog.json")
	preview := "{\"sequence\":0,\"timestamp\":1,\"policyLoadEvent\":{}}\n"
	rest := "{\"sequence\":1,\"timestamp\":1,\"summaryEvent\":{\"isPreview\":true}}\n"
	if err := os.WriteFile(path, []byte(preview+rest), 0644); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	read := int64(len(preview + rest))
	first := []byte(preview)

	cases := []struct {
		name, log string
		want      bool
	}{
		{"the preview's log", preview + rest, false},
		{"emptied for the update", "", true},
		{"shorter than what was read", preview, true},
		{"as long, from another second", "{\"sequence\":0,\"timestamp\":2,\"policyLoadEvent\":{}}\n" + rest, true},
	}
	for _, c := range cases {
		if err := os.WriteFile(path, []byte(c.log), 0644); err != nil {
			t.Fatal(err)
		}
		if got := eventLogRestarted(file, read, first); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
