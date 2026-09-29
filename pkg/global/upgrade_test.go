package global

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUpgradeNodeWritesAlias(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"package.json":              `{"dependencies": {"sst": "4.17.1"}}`,
		"packages/app/package.json": `{"devDependencies": {"sst": "npm:@sst-community/sst@4.17.1"}}`,
		"packages/web/package.json": `{"dependencies": {"sst-other": "1.0.0"}}`,
	}
	for name, body := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(dir)

	updated, err := UpgradeNode("4.17.1", "4.17.2")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"package.json":              `{"dependencies": {"sst": "npm:@sst-community/sst@4.17.2"}}`,
		"packages/app/package.json": `{"devDependencies": {"sst": "npm:@sst-community/sst@4.17.2"}}`,
		"packages/web/package.json": files["packages/web/package.json"],
	}
	for name, body := range want {
		got, _ := os.ReadFile(filepath.Join(dir, name))
		if string(got) != body {
			t.Errorf("%s = %s, want %s", name, got, body)
		}
	}
	if len(updated) != 2 {
		t.Errorf("updated %v, want package.json and packages/app/package.json", updated)
	}
}
