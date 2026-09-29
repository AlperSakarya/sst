<p align="center">
  <a href="https://sst.dev/">
    <img alt="SST" src="https://raw.githubusercontent.com/sst/identity/main/variants/sst-full.svg" width="300" />
  </a>
</p>

---

Build full-stack apps on your own infrastructure.

> [!NOTE]
> **sst-community** is a community-maintained fork of [SST](https://github.com/anomalyco/sst). It is not affiliated with SST or Anomaly. It tracks upstream releases and carries fixes that haven't landed upstream yet.
>
> The fork has no published release yet, so the install commands below install upstream SST. To use the fork today, build it from source (see [Running Locally](#running-locally)).

## Installation

For JavaScript projects, install SST locally so the CLI version is tracked with your app. You can then run the CLI with the same package manager.

```bash
npm install sst
# pnpm add sst
# bun add sst
# yarn add sst
```

If you are not using JavaScript, you can install the CLI globally.

```bash
curl -fsSL https://sst.dev/install | bash
```

To install a specific version.

```bash
curl -fsSL https://sst.dev/install | VERSION=0.0.403 bash
```

To use a package manager, [check out our docs](https://sst.dev/docs/reference/cli/).

#### Manually

Download the pre-compiled binaries from the [releases](https://github.com/sst/sst/releases/latest) page and copy to the desired location.

## Get Started

Get started with your favorite framework:

- [Next.js](https://sst.dev/docs/start/aws/nextjs)
- [Remix](https://sst.dev/docs/start/aws/remix)
- [Astro](https://sst.dev/docs/start/aws/astro)
- [API](https://sst.dev/docs/start/aws/api)

## Learn More

Learn more about some of the key concepts:

- [Live](https://sst.dev/docs/live)
- [Linking](https://sst.dev/docs/linking)
- [Console](https://sst.dev/docs/console)
- [Components](https://sst.dev/docs/components)

## Contributing

Here's how you can contribute:

- Help us improve our docs
- Find a bug? Open an issue
- Feature request? Submit a PR 

## Running Locally

Run `bun run setup`. You need [Go](https://go.dev/) and [Bun](https://bun.sh/) installed.

Now you can run the CLI locally on any of the `examples/` apps.

```bash
cd examples/aws-api
go run ../../cmd/sst <command>
```

If you want to build the CLI binary, run `bun run build:cli`. This will create a `sst` binary that you can use.

For building the docs, run `bun run docs:generate` and `bun run docs:dev`.

---

**Found a bug or have a question about the fork?** [Open an issue](https://github.com/sst-community/sst/issues). For SST itself, see [anomalyco/sst](https://github.com/anomalyco/sst).
