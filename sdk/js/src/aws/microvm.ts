import { awsFetch, type AwsOptions } from "./client.js";

/**
 * The `microvm` client SDK is available through the following.
 *
 * @example
 * ```js title="src/app.ts"
 * import { microvm } from "sst/aws/microvm";
 * ```
 *
 * If you are not using Node.js, you can use the AWS SDK instead, with the link data in
 * `Resource`. For example, call
 * [`RunMicrovm`](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html)
 * with its `imageArn`, `imageVersion` and `executionRoleArn`.
 */
export namespace microvm {
  /**
   * The link data for the MicroVM image.
   *
   * @example
   * For example, let's say you have a MicroVM image.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.MicroVm("Sandbox", { image: { context: "./sandbox" } });
   * ```
   *
   * `Resource.Sandbox` will have all the link data.
   *
   * ```js title="src/app.ts"
   * import { Resource } from "sst";
   *
   * console.log(Resource.Sandbox);
   * ```
   */
  export interface Resource {
    /**
     * The ARN of the MicroVM image.
     */
    imageArn?: string;
    /**
     * The version of the image that was deployed.
     */
    imageVersion?: string;
    /**
     * The ARN of the role MicroVMs run with.
     */
    executionRoleArn?: string;
    /**
     * The log group the MicroVMs' logs go to.
     */
    logGroup?: string;
    /**
     * The network connectors that let requests reach a MicroVM.
     */
    ingressNetworkConnectors?: string[];
    /**
     * The network connectors a MicroVM reaches the internet through.
     */
    egressNetworkConnectors?: string[];
    /**
     * The port the app in a MicroVM listens on.
     */
    port: number;
    /**
     * The longest a MicroVM can exist, in seconds.
     */
    duration?: number;
    /**
     * When an idle MicroVM is suspended, and then terminated.
     */
    idle?: IdlePolicy;
    /**
     * Set in `sst dev`, where the app runs on your machine.
     */
    dev?: {
      url: string;
    };
  }

  interface IdlePolicy {
    autoResumeEnabled: boolean;
    maxIdleDurationSeconds: number;
    suspendedDurationSeconds: number;
  }

  type Duration = `${number} ${
    | "second"
    | "seconds"
    | "minute"
    | "minutes"
    | "hour"
    | "hours"}`;

  export interface Options {
    /**
     * Configure the options for the [aws4fetch](https://github.com/mhart/aws4fetch)
     * [`AWSClient`](https://github.com/mhart/aws4fetch?tab=readme-ov-file#new-awsclientoptions) used internally by the SDK.
     */
    aws?: AwsOptions;
  }

  export interface RunOptions extends Options {
    /**
     * Overrides the component's `duration`: the longest this MicroVM can exist, running
     * and suspended. Up to 8 hours.
     */
    duration?: Duration;
    /**
     * Overrides the component's `idle`. Pass `false` to keep this MicroVM running until
     * its `duration` is up.
     */
    idle?:
      | false
      | {
          suspendAfter?: Duration;
          terminateAfter?: Duration;
          autoResume?: boolean;
        };
    /**
     * How long `run` waits for the MicroVM to be running.
     * @default `"1 minute"`
     */
    timeout?: Duration;
  }

  export interface FetchInit extends RequestInit {
    /**
     * The port to send the request to, if not the component's `port`.
     */
    port?: number;
  }

  export type State =
    | "PENDING"
    | "RUNNING"
    | "SUSPENDING"
    | "SUSPENDED"
    | "TERMINATING"
    | "TERMINATED";

  export interface DescribeResponse {
    /**
     * The ID of the MicroVM.
     */
    id: string;
    /**
     * The state of the MicroVM. AWS updates it eventually, so it can lag behind.
     */
    state: State;
    /**
     * Why the MicroVM is in this state.
     */
    stateReason?: string;
    /**
     * The URL of the MicroVM.
     */
    url: string;
    /**
     * The raw response from the AWS API.
     */
    response: any;
  }

  /**
   * A running MicroVM, returned by `run` and `get`.
   */
  export interface MicroVm {
    /**
     * The ID of the MicroVM. Keep it to reach the same MicroVM later, with `get`.
     */
    id: string;
    /**
     * The URL of the MicroVM. A request to it needs a token from `token`, in the
     * `X-aws-proxy-auth` header. `fetch` adds it for you.
     */
    url: string;
    /**
     * Sends a request to the app in the MicroVM. It works like `fetch`, with a path
     * instead of a URL, and adds the token.
     *
     * ```js
     * const res = await vm.fetch("/exec", {
     *   method: "POST",
     *   body: JSON.stringify({ code })
     * });
     * ```
     */
    fetch(path: string, init?: FetchInit): Promise<Response>;
    /**
     * A token for requests to a port of the MicroVM, valid for up to an hour. `fetch`
     * refreshes it before it expires. Use this to let something else, like a browser,
     * reach the MicroVM.
     */
    token(port?: number): Promise<string>;
    /**
     * Gets the MicroVM's state.
     */
    describe(): Promise<DescribeResponse>;
    /**
     * Suspends the MicroVM. Its memory and disk are kept, and you stop paying for compute.
     */
    suspend(): Promise<void>;
    /**
     * Resumes a suspended MicroVM.
     */
    resume(): Promise<void>;
    /**
     * Terminates the MicroVM.
     */
    terminate(): Promise<void>;
  }

  const API = "/2025-09-09/microvms";

  /**
   * Runs a new MicroVM from the image, and waits until it's running.
   *
   * @example
   *
   * For example, let's say you have a MicroVM image.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.MicroVm("Sandbox", { image: { context: "./sandbox" } });
   * ```
   *
   * Run a MicroVM from it, send it requests, and terminate it.
   *
   * ```js title="src/app.ts"
   * import { Resource } from "sst";
   * import { microvm } from "sst/aws/microvm";
   *
   * const vm = await microvm.run(Resource.Sandbox);
   * const res = await vm.fetch("/hello");
   * await vm.terminate();
   * ```
   *
   * In `sst dev`, this doesn't start a MicroVM. The requests go to your app running on
   * your machine, and `terminate` does nothing.
   */
  export async function run(
    resource: Resource,
    options?: RunOptions,
  ): Promise<MicroVm> {
    if (resource.dev) return local(resource);

    const idle =
      options?.idle === false
        ? undefined
        : options?.idle
          ? {
              autoResumeEnabled: options.idle.autoResume ?? true,
              maxIdleDurationSeconds: toSeconds(
                options.idle.suspendAfter ?? "15 minutes",
              ),
              suspendedDurationSeconds: toSeconds(
                options.idle.terminateAfter ?? "15 minutes",
              ),
            }
          : resource.idle;

    const res = await call(
      API,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Retries of this request start one MicroVM, not one each.
          clientToken: crypto.randomUUID(),
          imageIdentifier: resource.imageArn,
          imageVersion: resource.imageVersion,
          executionRoleArn: resource.executionRoleArn,
          ingressNetworkConnectors: resource.ingressNetworkConnectors,
          egressNetworkConnectors: resource.egressNetworkConnectors,
          maximumDurationInSeconds: options?.duration
            ? toSeconds(options.duration)
            : resource.duration,
          idlePolicy: idle,
          logging: resource.logGroup
            ? { cloudWatch: { logGroup: resource.logGroup } }
            : undefined,
        }),
      },
      options,
    );
    const data = (await res.json()) as { microvmId: string; endpoint: string };
    const vm = remote(resource, data.microvmId, data.endpoint, options);

    const deadline =
      Date.now() + toSeconds(options?.timeout ?? "1 minute") * 1000;
    try {
      while (true) {
        const { state, stateReason } = await vm.describe();
        if (state === "RUNNING") return vm;
        if (state !== "PENDING")
          throw new Error(
            `MicroVM ${vm.id} is ${state}${
              stateReason ? `: ${stateReason}` : ""
            }`,
          );
        if (Date.now() > deadline)
          throw new Error(`MicroVM ${vm.id} didn't start in time`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (e) {
      // Don't leave behind a MicroVM the caller never got.
      await vm.terminate().catch(() => {});
      throw e;
    }
  }

  /**
   * Gets a MicroVM that's already running, by its ID. Use this to reach the same MicroVM
   * from a later request.
   *
   * ```js title="src/app.ts"
   * const vm = await microvm.get(Resource.Sandbox, id);
   * const res = await vm.fetch("/status");
   * ```
   */
  export async function get(
    resource: Resource,
    id: string,
    options?: Options,
  ): Promise<MicroVm> {
    if (resource.dev) return local(resource, id);
    const vm = remote(resource, id, undefined, options);
    await vm.describe();
    return vm;
  }

  function remote(
    resource: Resource,
    id: string,
    endpoint: string | undefined,
    options?: Options,
  ): MicroVm {
    const tokens = new Map<number, { value: string; expires: number }>();

    async function token(port = resource.port) {
      const cached = tokens.get(port);
      // Refresh with 5 minutes to spare.
      if (cached && cached.expires - Date.now() > 5 * 60 * 1000)
        return cached.value;
      const res = await call(
        `${API}/${id}/auth-token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expirationInMinutes: 60,
            allowedPorts: [{ port }],
          }),
        },
        options,
      );
      const data = (await res.json()) as {
        authToken: Record<string, string>;
      };
      const value = data.authToken["X-aws-proxy-auth"];
      tokens.set(port, { value, expires: Date.now() + 60 * 60 * 1000 });
      return value;
    }

    async function describe(): Promise<DescribeResponse> {
      const res = await call(`${API}/${id}`, { method: "GET" }, options);
      const data = (await res.json()) as any;
      endpoint = data.endpoint;
      return {
        id: data.microvmId,
        state: data.state,
        stateReason: data.stateReason,
        url: `https://${data.endpoint}`,
        response: data,
      };
    }

    const vm: MicroVm = {
      id,
      get url() {
        return `https://${endpoint}`;
      },
      async fetch(path, init) {
        const { port, ...rest } = init ?? {};
        const headers = new Headers(rest.headers);
        headers.set("X-aws-proxy-auth", await token(port));
        headers.set("X-aws-proxy-port", String(port ?? resource.port));
        return fetch(`https://${endpoint}${path}`, { ...rest, headers });
      },
      token,
      describe,
      async suspend() {
        await call(`${API}/${id}/suspend`, { method: "POST" }, options);
      },
      async resume() {
        await call(`${API}/${id}/resume`, { method: "POST" }, options);
      },
      async terminate() {
        await call(`${API}/${id}`, { method: "DELETE" }, options);
      },
    };
    return vm;
  }

  // In `sst dev`, every MicroVM is the app running on your machine.
  function local(resource: Resource, id?: string): MicroVm {
    const url = resource.dev!.url.replace(/\/$/, "");
    const microvmId = id ?? `dev-${crypto.randomUUID()}`;
    return {
      id: microvmId,
      url,
      async fetch(path, init) {
        const { port, ...rest } = init ?? {};
        const target = port ? url.replace(/:\d+$/, `:${port}`) : url;
        return fetch(`${target}${path}`, rest);
      },
      async token() {
        return "";
      },
      async describe() {
        return {
          id: microvmId,
          state: "RUNNING",
          url,
          response: {},
        };
      },
      async suspend() {},
      async resume() {},
      async terminate() {},
    };
  }

  async function call(path: string, init: RequestInit, options?: Options) {
    const res = await awsFetch("lambda", path, init, options);
    if (!res.ok) throw new MicroVmError(res, await res.text());
    return res;
  }

  function toSeconds(duration: Duration) {
    const [count, unit] = duration.split(" ");
    const value = parseFloat(count);
    if (unit.startsWith("hour")) return value * 3600;
    if (unit.startsWith("minute")) return value * 60;
    return value;
  }

  export class MicroVmError extends Error {
    constructor(
      public readonly response: Response,
      public readonly body: string,
    ) {
      super(`MicroVM request failed with ${response.status}: ${body}`);
    }
  }
}
