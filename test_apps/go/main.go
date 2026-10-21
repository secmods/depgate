package main

import (
	"fmt"

	"github.com/google/go-cmp/cmp"
	"github.com/google/uuid"
	"github.com/pkg/errors"
	"github.com/spf13/pflag"
	"github.com/stretchr/testify/assert"
	"golang.org/x/sync/errgroup"
)

func main() {
	_ = pflag.Args
	var g errgroup.Group
	_ = g.Wait
	fmt.Println(uuid.NewString(), errors.New("probe"), assert.AnError, cmp.Diff("a", "a"))
}
