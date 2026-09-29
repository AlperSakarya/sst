package telemetry

import "testing"

func TestTelemetryOffInThisBuild(t *testing.T) {
	if IsEnabled() {
		t.Error("IsEnabled() = true, want false")
	}
	if err := Enable(); err == nil {
		t.Error("Enable() succeeded, want an error")
	}
}
