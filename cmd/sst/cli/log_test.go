package cli

import (
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"testing"
)

// Past its limit, the log is moved to sst.log.1 and started again.
func TestCappedLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sst.log")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	original, limit := logFile, logLimit
	logFile, logLimit = file, 100
	t.Cleanup(func() {
		logFile.Close()
		logFile, logLimit = original, limit
		logSized, logSize = nil, 0
		debug.SetCrashOutput(logFile, debug.CrashOptions{})
	})

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
	current, _ := os.ReadFile(path)
	if string(current) != line {
		t.Errorf("sst.log has %q, want the third line", current)
	}

	// again, replacing the older sst.log.1
	for range 2 {
		(cappedLog{}).Write([]byte(line))
	}
	moved, _ = os.ReadFile(path + ".1")
	current, _ = os.ReadFile(path)
	if string(moved) != line+line || string(current) != line {
		t.Errorf("after starting again twice, sst.log.1 has %q and sst.log %q", moved, current)
	}
}
