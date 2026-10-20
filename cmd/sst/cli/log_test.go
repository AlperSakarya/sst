package cli

import (
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"testing"
)

// capLogAt makes logFile a new sst.log in a folder of the test's, capped at
// limit, until the test ends.
func capLogAt(t *testing.T, limit int64) string {
	path := filepath.Join(t.TempDir(), "sst.log")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	original, originalLimit := logFile, logLimit
	logFile, logLimit = file, limit
	t.Cleanup(func() {
		logFile.Close()
		logFile, logLimit = original, originalLimit
		logSized, logSize = nil, 0
		debug.SetCrashOutput(logFile, debug.CrashOptions{})
	})
	return path
}

// Past its limit, the log is moved to sst.log.1 and started again.
func TestCappedLog(t *testing.T) {
	path := capLogAt(t, 100)

	line := strings.Repeat("a", 39) + "\n"
	for range 3 {
		if _, err := (cappedLog{}).Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	// the third would take it past 100
	moved, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}
	if string(moved) != line+line {
		t.Errorf("sst.log.1 has %q, want the first two lines", moved)
	}
	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != line {
		t.Errorf("sst.log has %q, want the third line", current)
	}

	// again, replacing the older sst.log.1
	for range 2 {
		if _, err := (cappedLog{}).Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	if moved, err = os.ReadFile(path + ".1"); err != nil {
		t.Fatal(err)
	}
	if current, err = os.ReadFile(path); err != nil {
		t.Fatal(err)
	}
	if string(moved) != line+line || string(current) != line {
		t.Errorf("after starting again twice, sst.log.1 has %q and sst.log %q", moved, current)
	}
}

// A log that can't be moved to sst.log.1 is emptied, so it stays capped.
func TestCappedLogThatCantBeMoved(t *testing.T) {
	path := capLogAt(t, 100)
	// a folder that isn't empty can't be replaced by a file
	if err := os.MkdirAll(filepath.Join(path+".1", "kept"), 0755); err != nil {
		t.Fatal(err)
	}
	line := strings.Repeat("a", 39) + "\n"
	for range 3 {
		if _, err := (cappedLog{}).Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != line {
		t.Errorf("sst.log has %q, want only the third line", current)
	}
}
