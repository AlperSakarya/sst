package npm

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewestInMajor(t *testing.T) {
	published := []string{"4.17.2", "4.17.3", "4.18.0", "5.0.0-alpha.1", "5.0.0-alpha.2", "not-a-version"}

	cases := []struct{ current, want string }{
		{"4.17.2", "4.18.0"},
		{"5.0.0-alpha.1", "5.0.0-alpha.2"},
	}
	for _, c := range cases {
		newest, ok, err := NewestInMajor(c.current, published)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, c.want, newest, "from %s", c.current)
	}

	// Once 5.0.0 is out, a prerelease moves on to it
	newest, _, err := NewestInMajor("5.0.0-alpha.2", append(published, "5.0.0"))
	require.NoError(t, err)
	assert.Equal(t, "5.0.0", newest)

	// A dev build isn't a version
	_, ok, err := NewestInMajor("dev", published)
	assert.False(t, ok)
	assert.NoError(t, err)

	// Nothing in its major
	_, ok, err = NewestInMajor("6.0.0", published)
	assert.True(t, ok)
	assert.Error(t, err)
}

func TestNewest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/@acme/cli":
			w.Write([]byte(`{"versions":{"4.17.3":{},"4.18.0":{},"5.0.0-alpha.1":{}}}`))
		case "/@acme/cli/latest":
			w.Write([]byte(`{"name":"@acme/cli","version":"4.18.0"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	registry := Registry{url: server.URL}

	newest, err := Newest(registry, "@acme/cli", "5.0.0-alpha.1")
	require.NoError(t, err)
	assert.Equal(t, "5.0.0-alpha.1", newest)

	newest, err = Newest(registry, "@acme/cli", "4.17.3")
	require.NoError(t, err)
	assert.Equal(t, "4.18.0", newest)

	newest, err = Newest(registry, "@acme/cli", "dev")
	require.NoError(t, err)
	assert.Equal(t, "4.18.0", newest)
}
