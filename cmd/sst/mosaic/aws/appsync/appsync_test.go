package appsync

import "testing"

func TestFailedEvents(t *testing.T) {
	cases := map[string]int{
		`{"failed":[],"successful":[{"identifier":"a","index":0}]}`:                          0,
		`{"failed":[{"identifier":"a","index":0,"code":"X","message":"y"}],"successful":[]}`: 1,
		`{"successful":[{"identifier":"a","index":0}]}`:                                      0,
		`not json`: 0,
		``:         0,
	}
	for body, want := range cases {
		if got := failedEvents([]byte(body)); got != want {
			t.Errorf("failedEvents(%q) = %d, want %d", body, got, want)
		}
	}
}
