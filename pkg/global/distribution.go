package global

// Where this distribution of the CLI is released. Upstream SST releases from
// github.com/sst/sst and publishes the npm package "sst".
const (
	ReleaseRepo = "sst-community/sst"
	NPMPackage  = "@sst-community/sst"
	// Telemetry is off: the CLI's telemetry goes to SST's own PostHog project.
	Telemetry = false
)

// NPMSpec is the package.json dependency value that installs this distribution
// under the name "sst", so `import { Resource } from "sst"` keeps working.
func NPMSpec(version string) string {
	return "npm:" + NPMPackage + "@" + version
}
