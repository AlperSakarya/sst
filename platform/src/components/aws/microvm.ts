import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import { glob } from "glob";
import {
  ComponentResourceOptions,
  Output,
  all,
  asset,
  interpolate,
  output,
} from "@pulumi/pulumi";
import {
  cloudwatch,
  getCallerIdentityOutput,
  getPartitionOutput,
  getRegionOutput,
  iam,
  lambdamicrovms,
  s3,
} from "@pulumi/aws";
import { Component, Transform, transform } from "../component";
import { Link } from "../link";
import { Input } from "../input";
import { VisibleError } from "../error";
import { physicalName } from "../naming";
import { DurationHours, toSeconds } from "../duration";
import { DevCommand } from "../experimental/dev-command";
import { bootstrap } from "./helpers/bootstrap";
import { RETENTION } from "./logging";
import { FunctionArgs } from "./function";
import { Permission, permission } from "./permission";

export interface MicroVmArgs {
  /**
   * The image to run. Lambda builds it from your `Dockerfile`, on top of its Amazon Linux
   * 2023 base image.
   *
   * SST zips the `context` directory, puts the `dockerfile` at the root of the zip, and
   * uploads it. Lambda builds the image from the zip, starts your app, and takes a snapshot
   * that every MicroVM starts from. So your app starts once, at build time: anything it
   * does on startup, like reading the time or generating an ID, is the same in every
   * MicroVM.
   *
   * A build takes a few minutes, and runs again whenever the code, the `environment` or a
   * link's values change. If it fails, the deploy fails, and the build's logs are in the
   * log group. MicroVMs keep starting from the last version that built.
   *
   * Lambda runs the `Dockerfile` itself, so Docker build args, targets, secrets and caches
   * don't apply. Files matched by a `.dockerignore` in the `context` aren't uploaded.
   *
   * @default `{ context: ".", dockerfile: "Dockerfile" }`
   * @example
   * ```js
   * {
   *   image: {
   *     context: "./sandbox",
   *     dockerfile: "Dockerfile"
   *   }
   * }
   * ```
   */
  image?: Input<{
    /**
     * The path to the directory that's zipped and uploaded, relative to your project root.
     * @default `"."`
     */
    context?: Input<string>;
    /**
     * The path to the `Dockerfile`, relative to the `context`.
     * @default `"Dockerfile"`
     */
    dockerfile?: Input<string>;
  }>;
  /**
   * The port your app listens on. The SDK sends requests to this port.
   * @default `8080`
   */
  port?: Input<number>;
  /**
   * Key-value pairs set as environment variables in the image.
   *
   * They're part of the image, so changing them rebuilds it. Lambda allows up to 50.
   */
  environment?: FunctionArgs["environment"];
  /**
   * [Link resources](/docs/linking/) to your MicroVMs. This grants the execution role the
   * permissions of the linked resources, and sets them as environment variables in the
   * image, so your app can read them through the SDK.
   *
   * Changing a linked resource's values rebuilds the image.
   *
   * @example
   * ```js
   * {
   *   link: [bucket]
   * }
   * ```
   */
  link?: FunctionArgs["link"];
  /**
   * Permissions and the resources that your MicroVMs need to access. They're added to the
   * execution role.
   *
   * @example
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["bedrock:InvokeModel"],
   *       resources: ["*"]
   *     }
   *   ]
   * }
   * ```
   */
  permissions?: FunctionArgs["permissions"];
  /**
   * The longest a MicroVM can exist, running and suspended. Lambda terminates it after
   * this, up to 8 hours.
   *
   * This is the default for `microvm.run()` in the SDK, which can override it.
   *
   * @default `"1 hour"`
   */
  duration?: Input<DurationHours>;
  /**
   * When a MicroVM gets no requests for a while, Lambda suspends it, and you stop paying
   * for compute. Its memory and disk are kept. Then, if it stays suspended for too long,
   * Lambda terminates it.
   *
   * Pass `false` to keep MicroVMs running until `duration` is up.
   *
   * This is the default for `microvm.run()` in the SDK, which can override it.
   *
   * @default `{ suspendAfter: "15 minutes", terminateAfter: "15 minutes", autoResume: true }`
   */
  idle?: Input<
    | false
    | {
        /**
         * How long a MicroVM can go without a request before it's suspended. At least
         * 1 minute.
         * @default `"15 minutes"`
         */
        suspendAfter?: Input<DurationHours>;
        /**
         * How long a MicroVM can stay suspended before it's terminated.
         * @default `"15 minutes"`
         */
        terminateAfter?: Input<DurationHours>;
        /**
         * Resume a suspended MicroVM when a request arrives for it.
         * @default `true`
         */
        autoResume?: Input<boolean>;
      }
  >;
  /**
   * Configure the log group for your MicroVMs' logs.
   * @default `{ retention: "1 month" }`
   */
  logging?: Input<{
    /**
     * How long to keep the logs.
     * @default `"1 month"`
     */
    retention?: Input<keyof typeof RETENTION>;
  }>;
  /**
   * Configure how this component works in `sst dev`.
   *
   * By default, the image isn't built in `sst dev`. Instead, `dev.command` runs your app on
   * your machine, in a tab of the `sst dev` multiplexer, with the links and the execution
   * role's permissions.
   *
   * In `sst dev`, the SDK sends the requests of every MicroVM you run to `dev.url`. So the
   * MicroVMs aren't isolated from each other the way they are once deployed.
   *
   * To build the image and run real MicroVMs in `sst dev`, pass in `false`.
   */
  dev?:
    | false
    | {
        /**
         * The command that `sst dev` runs to start your app.
         */
        command?: Input<string>;
        /**
         * The directory the `command` runs in.
         * @default The `image.context`
         */
        directory?: Input<string>;
        /**
         * The URL your app listens on in `sst dev`.
         * @default `"http://localhost:8080"`, with your `port`
         */
        url?: Input<string>;
      };
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the MicroVM image resource.
     */
    image?: Transform<lambdamicrovms.ImageArgs>;
    /**
     * Transform the IAM role Lambda uses to build the image.
     */
    buildRole?: Transform<iam.RoleArgs>;
    /**
     * Transform the IAM role your MicroVMs run with.
     */
    executionRole?: Transform<iam.RoleArgs>;
    /**
     * Transform the CloudWatch log group.
     */
    logGroup?: Transform<cloudwatch.LogGroupArgs>;
  };
}

/**
 * The `MicroVm` component lets you run your code in
 * [AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html):
 * isolated, stateful sandboxes, each with its own HTTPS endpoint, that live for up to
 * 8 hours. For example, to run code that an AI agent wrote.
 *
 * The component creates the image. Your app then starts MicroVMs from it, and sends them
 * requests, with the [SDK](/docs/component/aws/microvm#sdk).
 *
 * :::note
 * Lambda MicroVMs run on ARM64 only, and are available in `us-east-1`, `us-east-2`,
 * `us-west-2`, `eu-west-1` and `ap-northeast-1`.
 * :::
 *
 * @example
 *
 * #### Create a MicroVM image
 *
 * ```ts title="sst.config.ts"
 * const sandbox = new sst.aws.MicroVm("Sandbox", {
 *   image: { context: "./sandbox" },
 *   dev: { command: "node app.js" }
 * });
 * ```
 *
 * Here `./sandbox` has a `Dockerfile` that starts an app listening on port 8080.
 *
 * #### Link it and run MicroVMs
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   link: [sandbox]
 * });
 * ```
 *
 * ```ts title="src/lambda.ts"
 * import { Resource } from "sst";
 * import { microvm } from "sst/aws/microvm";
 *
 * const vm = await microvm.run(Resource.Sandbox);
 * const res = await vm.fetch("/exec", {
 *   method: "POST",
 *   body: JSON.stringify({ code: "print(1 + 1)" })
 * });
 * await vm.terminate();
 * ```
 *
 * #### Limit how long MicroVMs live
 *
 * A MicroVM you don't terminate keeps running until it's idle, or until its `duration` is
 * up. These defaults keep that short; change them for long sessions.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.MicroVm("Sandbox", {
 *   image: { context: "./sandbox" },
 *   duration: "4 hours",
 *   idle: { suspendAfter: "10 minutes", terminateAfter: "1 hour" }
 * });
 * ```
 *
 * :::caution
 * Lambda can't delete an image while MicroVMs from it are running. So `sst remove`, and
 * starting `sst dev` on a deployed stage, fail until they're terminated, idle, or their
 * `duration` is up.
 * :::
 */
export class MicroVm extends Component implements Link.Linkable {
  private readonly image?: lambdamicrovms.Image;
  private readonly buildRole?: iam.Role;
  private readonly executionRole: iam.Role;
  private readonly logGroup: cloudwatch.LogGroup;
  private readonly region: Output<string>;
  private readonly partition: Output<string>;
  private readonly runDefaults: Output<{
    port: number;
    duration: number;
    idle?: {
      autoResumeEnabled: boolean;
      maxIdleDurationSeconds: number;
      suspendedDurationSeconds: number;
    };
  }>;
  private readonly devUrl?: Output<string>;

  constructor(
    name: string,
    args: MicroVmArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(__pulumiType, name, args, opts);

    const self = this;
    const dev = normalizeDev();
    const partition = getPartitionOutput({}, opts).partition;
    const region = getRegionOutput({}, opts).region;
    const image = normalizeImage();
    const runDefaults = normalizeRunDefaults();

    const logGroup = createLogGroup();
    const imageName = logGroup.name.apply((v) => v.split("/").at(-1)!);
    const executionRole = createExecutionRole();

    this.executionRole = executionRole;
    this.logGroup = logGroup;
    this.region = region;
    this.partition = partition;
    this.runDefaults = runDefaults;

    if (dev) {
      this.devUrl = all([args.dev ? args.dev.url : undefined, args.port]).apply(
        ([url, port]) => url ?? `http://localhost:${port ?? 8080}`,
      );
      registerDevCommand();
      return;
    }

    const code = createCode();
    const buildRole = createBuildRole();
    this.buildRole = buildRole;
    this.image = createImage();

    function normalizeDev() {
      if (!$dev) return false;
      if (args.dev === false) return false;
      return true;
    }

    function normalizeImage() {
      return output(args.image ?? {}).apply((image) => {
        const context = path.resolve($cli.paths.root, image.context ?? ".");
        const dockerfile = image.dockerfile ?? "Dockerfile";
        if (!fs.existsSync(path.join(context, dockerfile)))
          throw new VisibleError(
            `The "${name}" MicroVm can't find its Dockerfile at "${path.join(
              context,
              dockerfile,
            )}". Set "image.context" and "image.dockerfile".`,
          );
        return {
          context,
          dockerfile,
          // `sst dev` runs `dev.command` in a directory relative to the project root.
          directory: path.relative($cli.paths.root, context) || ".",
        };
      });
    }

    function normalizeRunDefaults() {
      return all([args.port, args.duration, args.idle]).apply(
        ([port, duration, idle]) => {
          const maxDuration = toSeconds(duration ?? "1 hour");
          if (maxDuration < 1 || maxDuration > 28800)
            throw new VisibleError(
              `The "${name}" MicroVm's "duration" is ${duration}. It has to be between 1 second and 8 hours.`,
            );
          if (idle === false)
            return { port: port ?? 8080, duration: maxDuration };

          const suspendAfter = toSeconds(idle?.suspendAfter ?? "15 minutes");
          if (suspendAfter < 60 || suspendAfter > 28800)
            throw new VisibleError(
              `The "${name}" MicroVm's "idle.suspendAfter" is ${idle?.suspendAfter}. It has to be between 1 minute and 8 hours.`,
            );
          return {
            port: port ?? 8080,
            duration: maxDuration,
            idle: {
              autoResumeEnabled: idle?.autoResume ?? true,
              maxIdleDurationSeconds: suspendAfter,
              suspendedDurationSeconds: toSeconds(
                idle?.terminateAfter ?? "15 minutes",
              ),
            },
          };
        },
      );
    }

    function createLogGroup() {
      return new cloudwatch.LogGroup(
        ...transform(
          args.transform?.logGroup,
          `${name}LogGroup`,
          {
            // Lambda writes the build logs to this log group, and the SDK sends the
            // MicroVMs' logs to it.
            name: `/aws/lambda-microvms/${physicalName(64, name)}`,
            retentionInDays: output(args.logging).apply(
              (logging) => RETENTION[logging?.retention ?? "1 month"],
            ),
          },
          { parent: self, ignoreChanges: ["name"] },
        ),
      );
    }

    function createExecutionRole() {
      const policy = all([
        args.permissions ?? [],
        Link.getInclude<Permission>("aws.permission", args.link),
      ]).apply(([argsPermissions, linkPermissions]) =>
        iam.getPolicyDocumentOutput({
          statements: [
            ...argsPermissions,
            ...linkPermissions,
            {
              effect: "allow" as const,
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [interpolate`${logGroup.arn}:*`],
            },
          ].map((item) => ({
            effect: (() => {
              const effect = item.effect ?? "allow";
              return effect.charAt(0).toUpperCase() + effect.slice(1);
            })(),
            actions: item.actions,
            resources: item.resources,
            conditions: "conditions" in item ? item.conditions : undefined,
          })),
        }),
      );

      return new iam.Role(
        ...transform(
          args.transform?.executionRole,
          `${name}ExecutionRole`,
          {
            assumeRolePolicy: iam.getPolicyDocumentOutput({
              statements: [
                {
                  actions: ["sts:AssumeRole", "sts:TagSession"],
                  principals: [
                    { type: "Service", identifiers: ["lambda.amazonaws.com"] },
                  ],
                },
                // In `sst dev`, the CLI assumes this role to run `dev.command`.
                ...(dev
                  ? [
                      {
                        actions: ["sts:AssumeRole"],
                        principals: [
                          {
                            type: "AWS",
                            identifiers: [
                              getCallerIdentityOutput({}, opts).accountId,
                            ],
                          },
                        ],
                      },
                    ]
                  : []),
              ],
            }).json,
            inlinePolicies: policy.apply(({ statements }) =>
              statements ? [{ name: "inline", policy: policy.json }] : [],
            ),
          },
          { parent: self },
        ),
      );
    }

    function registerDevCommand() {
      new DevCommand(
        `${name}Dev`,
        {
          link: args.link,
          dev: {
            title: name,
            autostart: true,
            directory: image.directory,
            ...(args.dev || {}),
          },
          environment: all([args.environment, region]).apply(
            ([environment, region]) => ({
              ...environment,
              AWS_REGION: region,
            }),
          ),
          aws: {
            role: executionRole.arn,
          },
        },
        { parent: self },
      );
    }

    function createCode() {
      const zip = image.apply(async ({ context, dockerfile }) => {
        const zipPath = path.resolve(
          $cli.paths.work,
          "artifacts",
          `${name}-microvm`,
          "code.zip",
        );
        await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });

        const files = (
          await glob("**", {
            cwd: context,
            dot: true,
            nodir: true,
            ignore: [
              ".sst/**",
              ".git/**",
              ...(await readDockerignore(context)),
              // Lambda reads the Dockerfile from the root of the zip.
              ...(dockerfile === "Dockerfile" ? [] : ["Dockerfile"]),
            ],
          })
        )
          .map((file) => ({ from: path.join(context, file), to: file }))
          .concat(
            dockerfile === "Dockerfile"
              ? []
              : [{ from: path.join(context, dockerfile), to: "Dockerfile" }],
          )
          .sort((a, b) => a.to.localeCompare(b.to));

        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(zipPath);
          // statConcurrency and the fixed dates keep the zip, and its hash, the same
          // when nothing changed, so the image isn't rebuilt.
          const archive = archiver("zip", { statConcurrency: 1 });
          archive.on("warning", reject);
          archive.on("error", reject);
          ws.once("close", () => resolve());
          archive.pipe(ws);
          for (const file of files)
            archive.file(file.from, { name: file.to, date: new Date(0) });
          archive.finalize();
        });

        const hash = crypto
          .createHash("sha256")
          .update(await fs.promises.readFile(zipPath))
          .digest("hex");
        return { path: zipPath, hash };
      });

      const bucket = region.apply((region) =>
        bootstrap.forRegion(region).then((d) => d.asset),
      );
      // One key per image, updated in place. With the hash in the key, a deploy that
      // fails and is then reverted replaces the object with one of the same key and
      // deletes it, and a later rebuild of unchanged code can't find it.
      const object = new s3.BucketObjectv2(
        `${name}Code`,
        {
          key: interpolate`assets/microvm/${imageName}.zip`,
          bucket,
          source: zip.path.apply((p) => new asset.FileArchive(p)),
        },
        { parent: self },
      );
      return { object, hash: zip.hash };
    }

    function createBuildRole() {
      return new iam.Role(
        ...transform(
          args.transform?.buildRole,
          `${name}BuildRole`,
          {
            assumeRolePolicy: iam.getPolicyDocumentOutput({
              statements: [
                {
                  actions: ["sts:AssumeRole", "sts:TagSession"],
                  principals: [
                    { type: "Service", identifiers: ["lambda.amazonaws.com"] },
                  ],
                },
              ],
            }).json,
            inlinePolicies: [
              {
                name: "inline",
                policy: iam.getPolicyDocumentOutput({
                  statements: [
                    {
                      actions: ["s3:GetObject"],
                      resources: [
                        interpolate`arn:${partition}:s3:::${code.object.bucket}/${code.object.key}`,
                      ],
                    },
                    {
                      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                      resources: [interpolate`${logGroup.arn}:*`],
                    },
                  ],
                }).json,
              },
            ],
          },
          { parent: self },
        ),
      );
    }

    function createImage() {
      return new lambdamicrovms.Image(
        ...transform(
          args.transform?.image,
          `${name}Image`,
          {
            name: imageName,
            baseImageArn: interpolate`arn:${partition}:lambda:${region}:aws:microvm-image:al2023-1`,
            buildRoleArn: buildRole.arn,
            codeArtifact: {
              uri: interpolate`s3://${code.object.bucket}/${code.object.key}`,
            },
            // The code's key doesn't change, so its hash is what rebuilds the image
            // when the code changes.
            description: interpolate`Code ${code.hash.apply((h) =>
              h.slice(0, 16),
            )}`,
            environmentVariables: all([
              args.environment ?? {},
              Link.propertiesToEnv(Link.getProperties(args.link)),
            ]).apply(([environment, linkEnvironment]) => {
              const variables = { ...environment, ...linkEnvironment };
              if (Object.keys(variables).length > 50)
                throw new VisibleError(
                  `The "${name}" MicroVm has ${
                    Object.keys(variables).length
                  } environment variables, from "environment" and one for each link. Lambda allows up to 50.`,
                );
              return variables;
            }),
          },
          { parent: self, ignoreChanges: ["name"] },
        ),
      );
    }

    async function readDockerignore(context: string) {
      const content = await fs.promises
        .readFile(path.join(context, ".dockerignore"), "utf8")
        .catch(() => "");
      const patterns = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      if (patterns.some((p) => p.startsWith("!")))
        throw new VisibleError(
          `The "${name}" MicroVm's .dockerignore has an exception ("!"), which isn't supported yet.`,
        );
      return patterns
        .map((p) => p.replace(/^\.?\//, "").replace(/\/$/, ""))
        .flatMap((p) => [p, `${p}/**`]);
    }
  }

  /**
   * The ARN of the MicroVM image. Not created in `sst dev`, unless `dev` is `false`.
   */
  public get arn() {
    return this.image?.arn;
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    return {
      /**
       * The MicroVM image. Not created in `sst dev`, unless `dev` is `false`.
       */
      image: this.image,
      /**
       * The IAM role Lambda uses to build the image.
       */
      buildRole: this.buildRole,
      /**
       * The IAM role your MicroVMs run with.
       */
      executionRole: this.executionRole,
      /**
       * The CloudWatch log group.
       */
      logGroup: this.logGroup,
    };
  }

  /** @internal */
  public getSSTLink() {
    if (this.devUrl)
      return {
        properties: {
          dev: { url: this.devUrl },
          port: this.runDefaults.port,
        },
      };

    const connector = (type: string) =>
      interpolate`arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:${type}`;

    return {
      properties: {
        imageArn: this.image!.arn,
        // Pin the version, so a MicroVM runs the image deployed with the code that started it.
        imageVersion: this.image!.imageVersion,
        executionRoleArn: this.executionRole.arn,
        logGroup: this.logGroup.name,
        ingressNetworkConnectors: [connector("ALL_INGRESS")],
        egressNetworkConnectors: [connector("INTERNET_EGRESS")],
        port: this.runDefaults.port,
        duration: this.runDefaults.duration,
        idle: this.runDefaults.idle,
      },
      include: [
        permission({
          actions: [
            "lambda:RunMicrovm",
            "lambda:GetMicrovm",
            "lambda:SuspendMicrovm",
            "lambda:ResumeMicrovm",
            "lambda:TerminateMicrovm",
            "lambda:CreateMicrovmAuthToken",
          ],
          // A MicroVM has no ARN of its own: these are authorized on its image.
          resources: [this.image!.arn],
        }),
        permission({
          actions: ["lambda:ListMicrovms", "lambda:PassNetworkConnector"],
          resources: ["*"],
        }),
        permission({
          actions: ["iam:PassRole"],
          resources: [this.executionRole.arn],
        }),
      ],
    };
  }
}

const __pulumiType = "sst:aws:MicroVm";
// @ts-expect-error
MicroVm.__pulumiType = __pulumiType;
