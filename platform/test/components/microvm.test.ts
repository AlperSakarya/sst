import { describe, beforeAll, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import fs from "fs";
import os from "os";
import path from "path";

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

vi.mock("../../src/components/aws/helpers/bootstrap", () => ({
  bootstrap: {
    forRegion: async () => ({ asset: "sst-asset-test" }),
  },
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "microvm-test-"));
fs.mkdirSync(path.join(root, "sandbox"));
fs.writeFileSync(
  path.join(root, "sandbox", "Dockerfile"),
  "FROM node:24-alpine\n",
);
fs.writeFileSync(path.join(root, "sandbox", "app.mjs"), "// app\n");

// @ts-ignore
global.$app = { name: "app", stage: "test" };
global.$util = pulumi;
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$cli = { paths: { root, work: path.join(root, ".sst") } };

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

let createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: `${args.name}_id`,
        state: {
          ...args.inputs,
          arn: `arn:aws:test:::${args.name}`,
          imageVersion: "1.0",
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      if (args.token === "aws:index/getPartition:getPartition")
        return { partition: "aws" };
      if (args.token === "aws:index/getRegion:getRegion")
        return { region: "us-west-2", name: "us-west-2" };
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity")
        return { accountId: "123456789012" };
      if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument")
        return { json: JSON.stringify(args.inputs) };
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

const IMAGE_TYPE = "aws:lambdamicrovms/image:Image";
const ROLE_TYPE = "aws:iam/role:Role";
const LOG_GROUP_TYPE = "aws:cloudwatch/logGroup:LogGroup";

// Only the resources of the component named `prefix`, so a test can't see another
// test's resources that are still being registered.
function find(type: string, prefix: string) {
  return createdResources.filter(
    (r) => r.type === type && r.name.startsWith(prefix),
  );
}

async function settle() {
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function unwrap<T>(value: pulumi.Input<T>) {
  return new Promise<T>((resolve) =>
    pulumi.output(value).apply(resolve as any),
  );
}

describe("MicroVm", function () {
  let MicroVm: typeof import("./../../src/components/aws/microvm").MicroVm;

  beforeAll(async function () {
    MicroVm = (await import("./../../src/components/aws/microvm")).MicroVm;
  });

  beforeEach(function () {
    createdResources = [];
    // @ts-ignore
    global.$dev = false;
  });

  it("builds the image from the context, with the environment", async () => {
    new MicroVm("Basic", {
      image: { context: "sandbox" },
      environment: { GREETING: "hi" },
    });
    await settle();

    const images = find(IMAGE_TYPE, "Basic");
    expect(images).toHaveLength(1);
    const image = images[0].inputs;
    expect(image.baseImageArn).toBe(
      "arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1",
    );
    expect(image.name).toMatch(/^app-test-Basic-[a-z]{8}$/);
    expect(image.codeArtifact.uri).toBe(
      `s3://sst-asset-test/assets/microvm/${image.name}.zip`,
    );
    expect(image.description).toMatch(/^Code [0-9a-f]{16}$/);
    expect(image.environmentVariables.GREETING).toBe("hi");
    expect(JSON.parse(image.environmentVariables.SST_RESOURCE_App)).toEqual({
      name: "app",
      stage: "test",
    });

    const prune = find("pulumi-nodejs:dynamic:Resource", "BasicImagePrune")[0];
    expect(prune.name).toBe("BasicImagePrune.sst.aws.MicrovmImagePrune");
    expect(prune.inputs).toMatchObject({
      imageArn: "arn:aws:test:::BasicImage",
      imageVersion: "1.0",
      region: "us-west-2",
      keep: 5,
    });

    const logGroup = find(LOG_GROUP_TYPE, "Basic")[0].inputs;
    expect(logGroup.name).toBe(`/aws/lambda-microvms/${image.name}`);
    expect(logGroup.retentionInDays).toBe(30);
  });

  it("lets only Lambda assume the roles outside sst dev", async () => {
    new MicroVm("Roles", { image: { context: "sandbox" } });
    await settle();

    const roles = find(ROLE_TYPE, "Roles");
    expect(roles.map((r) => r.name).sort()).toEqual([
      "RolesBuildRole",
      "RolesExecutionRole",
    ]);
    for (const role of roles) {
      const trust = JSON.parse(role.inputs.assumeRolePolicy);
      expect(trust.statements).toHaveLength(1);
      expect(trust.statements[0].principals).toEqual([
        { type: "Service", identifiers: ["lambda.amazonaws.com"] },
      ]);
    }

    const imageName = find(IMAGE_TYPE, "Roles")[0].inputs.name;
    const build = roles.find((r) => r.name === "RolesBuildRole")!;
    const policy = JSON.parse(build.inputs.inlinePolicies[0].policy);
    expect(policy.statements[0].resources).toEqual([
      `arn:aws:s3:::sst-asset-test/assets/microvm/${imageName}.zip`,
    ]);
  });

  it("links run permissions scoped to the image", async () => {
    const vm = new MicroVm("Link", { image: { context: "sandbox" } });
    const link = vm.getSSTLink();
    const include = await unwrap(link.include as any);
    const actions = (include as any[]).map((p) => [p.actions, p.resources]);
    expect(actions).toEqual([
      [
        [
          "lambda:RunMicrovm",
          "lambda:GetMicrovm",
          "lambda:SuspendMicrovm",
          "lambda:ResumeMicrovm",
          "lambda:TerminateMicrovm",
          "lambda:CreateMicrovmAuthToken",
        ],
        ["arn:aws:test:::LinkImage"],
      ],
      [["lambda:ListMicrovms", "lambda:PassNetworkConnector"], ["*"]],
      [["iam:PassRole"], ["arn:aws:test:::LinkExecutionRole"]],
    ]);

    const properties = await unwrap(link.properties as any);
    expect(properties).toMatchObject({
      imageArn: "arn:aws:test:::LinkImage",
      imageVersion: "1.0",
      port: 8080,
      duration: 3600,
      idle: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: 900,
        suspendedDurationSeconds: 900,
      },
      ingressNetworkConnectors: [
        "arn:aws:lambda:us-west-2:aws:network-connector:aws-network-connector:ALL_INGRESS",
      ],
    });
  });

  it("leaves out the idle policy when idle is false", async () => {
    const vm = new MicroVm("NoIdle", {
      image: { context: "sandbox" },
      idle: false,
      duration: "8 hours",
    });
    const properties: any = await unwrap(vm.getSSTLink().properties as any);
    expect(properties.duration).toBe(28800);
    expect(properties.idle).toBeUndefined();
  });

  it("stops a duration longer than 8 hours", async () => {
    const vm = new MicroVm("TooLong", {
      image: { context: "sandbox" },
      duration: "9 hours",
    });
    // The error is thrown inside an apply, so every link property that comes from it
    // rejects. Handle the promises Pulumi derives from them too, or they're reported as
    // unhandled.
    const properties = vm.getSSTLink().properties as any;
    for (const out of [properties.port, properties.duration, properties.idle]) {
      out.isKnown.catch(() => {});
      out.isSecret.catch(() => {});
      out.allResources?.().catch(() => {});
      out.promise().catch(() => {});
    }
    await expect(properties.duration.promise()).rejects.toThrow(
      'The "TooLong" MicroVm\'s "duration" is 9 hours.',
    );
  });

  it("puts a dockerfile from elsewhere in the context at the root of the zip", async () => {
    fs.mkdirSync(path.join(root, "nested", "docker"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "nested", "docker", "Dockerfile.prod"),
      "FROM scratch\n",
    );
    fs.writeFileSync(path.join(root, "nested", "app.mjs"), "// app\n");
    new MicroVm("Nested", {
      image: { context: "nested", dockerfile: "docker/Dockerfile.prod" },
    });
    await settle();
    expect(find(IMAGE_TYPE, "Nested")).toHaveLength(1);

    const zip = fs.readFileSync(
      path.join(root, ".sst", "artifacts", "Nested-microvm", "code.zip"),
    );
    // File names are stored uncompressed in a zip's headers.
    const names = zip.toString("latin1");
    expect(names).toContain("Dockerfile");
    expect(names).toContain("app.mjs");
    expect(names).toContain("docker/Dockerfile.prod");
  });

  it("leaves the sst-env.d.ts files out of the zip", async () => {
    fs.mkdirSync(path.join(root, "typed", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "typed", "Dockerfile"), "FROM scratch\n");
    fs.writeFileSync(path.join(root, "typed", "app.mjs"), "// app\n");
    fs.writeFileSync(path.join(root, "typed", "sst-env.d.ts"), "// types\n");
    fs.writeFileSync(
      path.join(root, "typed", "lib", "sst-env.d.ts"),
      "// types\n",
    );
    new MicroVm("Typed", { image: { context: "typed" } });
    await settle();
    expect(find(IMAGE_TYPE, "Typed")).toHaveLength(1);

    const names = fs
      .readFileSync(
        path.join(root, ".sst", "artifacts", "Typed-microvm", "code.zip"),
      )
      .toString("latin1");
    expect(names).toContain("app.mjs");
    expect(names).not.toContain("sst-env.d.ts");
  });

  it("runs MicroVMs through a network connector in the VPC", async () => {
    const vm = new MicroVm("InVpc", {
      image: { context: "sandbox" },
      vpc: {
        privateSubnets: ["subnet-1", "subnet-2"],
        securityGroups: ["sg-1"],
      },
    });
    await settle();

    const connectors = find(
      "aws:lambda/coreNetworkConnector:CoreNetworkConnector",
      "InVpc",
    );
    expect(connectors).toHaveLength(1);
    expect(connectors[0].inputs.configuration).toEqual({
      vpcEgressConfiguration: {
        associatedComputeResourceTypes: ["MicroVm"],
        networkProtocol: "IPv4",
        subnetIds: ["subnet-1", "subnet-2"],
        securityGroupIds: ["sg-1"],
      },
    });
    expect(connectors[0].inputs.operatorRole).toBe(
      "arn:aws:test:::InVpcOperatorRole",
    );

    const operator = find(ROLE_TYPE, "InVpcOperatorRole")[0];
    // assumeRolePolicyForPrincipal gives an object, not a JSON string.
    const trust = operator.inputs.assumeRolePolicy;
    expect(trust.Statement[0].Principal).toEqual({
      Service: "network-connectors.lambda.amazonaws.com",
    });

    const properties: any = await unwrap(vm.getSSTLink().properties as any);
    expect(properties.egressNetworkConnectors).toEqual([
      "arn:aws:test:::InVpcNetworkConnector",
    ]);
  });

  it("runs the app locally in sst dev, without building the image", async () => {
    // @ts-ignore
    global.$dev = true;
    const vm = new MicroVm("Dev", {
      image: { context: "sandbox" },
      dev: { command: "node app.mjs", url: "http://localhost:9000" },
    });
    await settle();

    expect(find(IMAGE_TYPE, "Dev")).toHaveLength(0);
    expect(find(ROLE_TYPE, "Dev").map((r) => r.name)).toEqual([
      "DevExecutionRole",
    ]);
    const trust = JSON.parse(find(ROLE_TYPE, "Dev")[0].inputs.assumeRolePolicy);
    expect(trust.statements[1].principals).toEqual([
      { type: "AWS", identifiers: ["123456789012"] },
    ]);

    const link = vm.getSSTLink();
    expect(link.include).toBeUndefined();
    expect(await unwrap(link.properties as any)).toEqual({
      dev: { url: "http://localhost:9000" },
      port: 8080,
    });
  });
});
