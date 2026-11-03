package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/pood1e/agentos-platform/controller/internal/render"
	platformscheme "github.com/pood1e/agentos-platform/controller/internal/scheme"
	"sigs.k8s.io/yaml"
)

func run() error {
	namespace := flag.String("namespace", "agentos", "Resource namespace")
	release := flag.String("release", "agentos", "Platform Helm release name")
	format := flag.String("format", "yaml", "Output format: yaml or json")
	flag.Parse()
	objects, err := render.Read(os.Stdin)
	if err != nil {
		return err
	}
	scheme, err := platformscheme.New()
	if err != nil {
		return err
	}
	gateway := render.Gateway(objects, *release, *namespace)
	expanded, err := render.Expand(objects, scheme, *namespace, gateway)
	if err != nil {
		return err
	}
	if *format == "json" {
		return json.NewEncoder(os.Stdout).Encode(expanded)
	}
	if *format != "yaml" {
		return fmt.Errorf("unsupported format %s", *format)
	}
	for _, object := range expanded {
		data, err := yaml.Marshal(object.Object)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(os.Stdout, "---\n%s", data); err != nil {
			return err
		}
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
