import { describe, beforeAll, beforeEach, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
};
global.$util = pulumi;

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

let createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs): {
      id: string;
      state: any;
    } {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: args.inputs.name + "_id",
        state: {
          ...args.inputs,
          arn: `arn:aws:mock:us-east-1:account:${args.name}`,
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

const TYPES = {
  cfFunction: "aws:cloudfront/function:Function",
  cfDistribution: "aws:cloudfront/distribution:Distribution",
};

function findResources(type: string) {
  return createdResources.filter((r) => r.type === type);
}

// Flush event loop to let Pulumi .apply() chains settle without wall-clock delays
async function settle() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("Router catch-all route", function () {
  let Router: typeof import("./../../src/components/aws/router").Router;

  beforeAll(async function () {
    Router = (await import("./../../src/components/aws/router")).Router;
  });

  beforeEach(function () {
    createdResources = [];
  });

  it("returns 404 at the edge when no /* route is defined", async () => {
    new Router("NoCatchAll", {
      routes: { "/api/*": "https://example.com" },
    });
    await settle();

    const code = findResources(TYPES.cfFunction)
      .map((fn) => fn.inputs.code as string)
      .join("\n");
    expect(code).toContain("statusCode: 404");
    // the page is HTML, so it says so
    expect(code).toContain(
      '"content-type": { value: "text/html; charset=utf-8" }',
    );
  });

  it("attaches the 404 function to the default cache behavior", async () => {
    new Router("DefaultBehavior", {
      routes: { "/api/*": "https://example.com" },
    });
    await settle();

    // The function whose code answers with the 404 ...
    const notFound = findResources(TYPES.cfFunction).filter((fn) =>
      (fn.inputs.code as string).includes("statusCode: 404"),
    );
    expect(notFound).toHaveLength(1);

    // ... is the viewer-request function of the distribution's default behavior,
    // which is the one that handles a path no route matches.
    const [distribution] = findResources(TYPES.cfDistribution);
    const associations = await new Promise<any[]>((resolve) =>
      pulumi
        .output(distribution.inputs.defaultCacheBehavior)
        .apply((behavior: any) =>
          resolve(behavior.functionAssociations as any[]),
        ),
    );
    const viewerRequests = associations.filter(
      (a) => a.eventType === "viewer-request",
    );
    expect(viewerRequests).toHaveLength(1);
    expect(String(viewerRequests[0].functionArn)).toContain(notFound[0].name);
  });

  it("does not inject a 404 when a /* route is defined", async () => {
    new Router("WithCatchAll", {
      routes: {
        "/api/*": "https://example.com",
        "/*": "https://example.org",
      },
    });
    await settle();

    const code = findResources(TYPES.cfFunction)
      .map((fn) => fn.inputs.code as string)
      .join("\n");
    expect(code).not.toContain("statusCode: 404");
  });
});
