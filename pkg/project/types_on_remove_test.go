package project

import "testing"

func TestGeneratesTypes(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		input StackInput
		want  bool
	}{
		{"deploy", StackInput{Command: "deploy"}, true},
		{"diff", StackInput{Command: "diff"}, true},
		{"refresh", StackInput{Command: "refresh"}, true},
		{"dev", StackInput{Command: "deploy", Dev: true}, true},
		{"remove of the whole stage", StackInput{Command: "remove"}, false},
		{"remove with an empty target", StackInput{Command: "remove", Target: []string{}}, false},
		{"remove of one component", StackInput{Command: "remove", Target: []string{"Files"}}, true},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			if got := generatesTypes(&c.input); got != c.want {
				t.Fatalf("generatesTypes(%+v) = %v, want %v", c.input, got, c.want)
			}
		})
	}
}
