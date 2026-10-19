package aws

import (
	"fmt"
	"maps"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/flag"
)

// overSocket is what the harness's AppSync got over its socket, by message type.
func overSocket(h *harness) map[bridge.MessageType]int {
	h.appsync.mu.Lock()
	defer h.appsync.mu.Unlock()
	return maps.Clone(h.appsync.overSocket)
}

// Only the first copy of a reply goes over the socket, as the bridge is waiting
// on it. Pings, reboots and the reply's resends go over HTTPS.
func TestOnlyARepliesFirstCopyGoesOverTheSocket(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.addFunction("fn")
	b := h.bridge("fn")
	for i := range 3 {
		if _, err := b.invoke(fmt.Sprintf("event %d", i)); err != nil {
			t.Fatalf("invocation %d: %v", i, err)
		}
	}
	// the last reply is resent, which goes over HTTPS
	time.Sleep(replyResendEvery + 500*time.Millisecond)
	got := overSocket(h)
	if got[bridge.MessageResponse] != 3 || len(got) != 1 {
		t.Fatalf("over the socket: %v, want the 3 replies' first copies only", got)
	}
}

// With SST_DEV_HTTP_PUBLISH, nothing goes over the socket.
func TestHTTPPublishKeepsRepliesOffTheSocket(t *testing.T) {
	httpOnly := flag.SST_DEV_HTTP_PUBLISH
	flag.SST_DEV_HTTP_PUBLISH = true
	t.Cleanup(func() { flag.SST_DEV_HTTP_PUBLISH = httpOnly })
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.addFunction("fn")
	b := h.bridge("fn")
	if _, err := b.invoke("event"); err != nil {
		t.Fatal(err)
	}
	if got := overSocket(h); len(got) != 0 {
		t.Fatalf("over the socket: %v, want nothing", got)
	}
}
