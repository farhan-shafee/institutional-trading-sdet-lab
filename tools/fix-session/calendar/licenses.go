// Collect the license bytes for modules actually linked into this exact peer.
// This build helper is not linked into the runtime binary.
package main

import (
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

func main() {
	info, err := buildinfo.ReadFile("/out/peer")
	if err != nil {
		panic(err)
	}
	root := "/out/licenses"
	if err = os.MkdirAll(root, 0755); err != nil {
		panic(err)
	}
	files := map[string]any{}
	modules := map[string]any{}
	copyFile := func(source, name string) {
		data, e := os.ReadFile(source)
		if e != nil {
			panic(e)
		}
		if len(data) == 0 || len(data) > 1024*1024 {
			panic("LICENSE_SIZE")
		}
		if e = os.WriteFile(filepath.Join(root, name), data, 0644); e != nil {
			panic(e)
		}
		files[name] = map[string]any{"bytes": len(data), "sha256": fmt.Sprintf("%x", sha256.Sum256(data))}
	}
	copyFile("/usr/local/go/LICENSE", "go-toolchain-LICENSE")
	safe := regexp.MustCompile(`[^a-zA-Z0-9._@+-]`)
	for _, dep := range info.Deps {
		if dep.Replace != nil {
			panic("UNREVIEWED_MODULE_REPLACEMENT")
		}
		output, e := exec.Command("go", "list", "-m", "-json", dep.Path).Output()
		if e != nil {
			panic(e)
		}
		var module struct{ Path, Version, Dir, Sum string }
		if e = json.Unmarshal(output, &module); e != nil {
			panic(e)
		}
		if module.Path != dep.Path || module.Version != dep.Version || module.Sum != dep.Sum || module.Dir == "" {
			panic("LINKED_MODULE_IDENTITY")
		}
		entries, e := os.ReadDir(module.Dir)
		if e != nil {
			panic(e)
		}
		names := []string{}
		hasLicense := false
		for _, entry := range entries {
			upper := strings.ToUpper(entry.Name())
			if !entry.Type().IsRegular() {
				continue
			}
			if strings.HasPrefix(upper, "LICENSE") || strings.HasPrefix(upper, "COPYING") {
				hasLicense = true
			} else if upper != "NOTICE" && upper != "AUTHORS" && upper != "CONTRIBUTORS" && upper != "PATENTS" {
				continue
			}
			name := safe.ReplaceAllString(dep.Path+"@"+dep.Version+"-"+entry.Name(), "_")
			copyFile(filepath.Join(module.Dir, entry.Name()), name)
			names = append(names, name)
		}
		if !hasLicense {
			panic("LINKED_MODULE_LICENSE_MISSING")
		}
		modules[dep.Path] = map[string]any{"version": dep.Version, "sum": dep.Sum, "license_files": names}
	}
	if len(modules) == 0 {
		panic("LINKED_MODULE_DISCOVERY")
	}
	data, err := json.MarshalIndent(map[string]any{"go_version": info.GoVersion, "modules": modules, "files": files}, "", "  ")
	if err != nil {
		panic(err)
	}
	if err = os.WriteFile(filepath.Join(root, "go-dependencies.json"), append(data, '\n'), 0644); err != nil {
		panic(err)
	}
	fmt.Printf("LINKED_GO_LICENSES modules=%d files=%d\n", len(modules), len(files))
}
