// Test-only workspace. Production uses the original module cache, never this copy.
package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	output, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/quickfixgo/quickfix").Output()
	if err != nil {
		panic(err)
	}
	root := strings.TrimSpace(string(output))
	if root == "" {
		panic("CALENDAR_MODULE")
	}
	target := "/tmp/calendar-module"
	count := 0
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, e := filepath.Rel(root, path)
		if e != nil {
			return e
		}
		dest := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(dest, 0700)
		}
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("CALENDAR_SOURCE_TYPE")
		}
		data, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		if e = os.WriteFile(dest, data, 0600); e != nil {
			return e
		}
		copied, e := os.ReadFile(dest)
		if e != nil {
			return e
		}
		if sha256.Sum256(data) != sha256.Sum256(copied) {
			return fmt.Errorf("CALENDAR_SOURCE_HASH")
		}
		count++
		return nil
	})
	if err != nil {
		panic(err)
	}
	data, err := os.ReadFile("calendar/continuous_test.go")
	if err != nil {
		panic(err)
	}
	if err = os.WriteFile(filepath.Join(target, "tradeflow_continuous_test.go"), data, 0600); err != nil {
		panic(err)
	}
	if err = os.WriteFile("/tmp/calendar.work", []byte("go 1.27.3\nuse (\n/build\n/tmp/calendar-module\n)\n"), 0600); err != nil {
		panic(err)
	}
	fmt.Printf("CALENDAR_TEST_COPY production_edits=0 verified_files=%d\n", count)
}
