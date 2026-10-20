package cli

import (
	"os"
	"runtime/debug"
	"sync"
)

// How big logFile gets before it's started again. sst dev logs every
// invocation, so a long session would otherwise grow it for as long as it
// runs.
var logLimit int64 = 50 << 20

var (
	logMu sync.Mutex
	// the file logSize is the size of, as InitProject swaps logFile
	logSized *os.File
	logSize  int64
)

// cappedLog writes to logFile. Once that's past logLimit, it moves what's
// there to <name>.1, replacing an older one, and starts the file again.
type cappedLog struct{}

func (cappedLog) Write(p []byte) (int, error) {
	logMu.Lock()
	defer logMu.Unlock()
	if logSized != logFile {
		logSized, logSize = logFile, 0
		if info, err := logFile.Stat(); err == nil {
			logSize = info.Size()
		}
	}
	if logSize > 0 && logSize+int64(len(p)) > logLimit {
		if next, err := startLogAgain(logFile); err == nil {
			logFile, logSized, logSize = next, next, 0
			debug.SetCrashOutput(logFile, debug.CrashOptions{})
		}
	}
	n, err := logFile.Write(p)
	logSize += int64(n)
	return n, err
}

// The file is closed before it's moved, as Windows can't move an open file
func startLogAgain(file *os.File) (*os.File, error) {
	path := file.Name()
	file.Close()
	if err := os.Rename(path, path+".1"); err != nil {
		return os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0644)
	}
	return os.Create(path)
}
