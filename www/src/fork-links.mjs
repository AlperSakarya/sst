// Rehype plugin for the sst-community docs site, which is served under a base
// path (sst-community.github.io/sst). Root-relative links in Markdown and MDX
// get the base prefix. Links to pages the fork doesn't publish (SST's blog,
// about and legal pages) point at sst.dev instead.
const UPSTREAM_ONLY = ["/blog", "/about", "/legal"];
const ATTRIBUTES = ["href", "src", "link"];

export default function forkLinks({ base }) {
  const rewrite = (value) => {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return value;
    if (value === base || value.startsWith(base + "/")) return value;
    if (UPSTREAM_ONLY.some((p) => value === p || value.startsWith(p + "/"))) return "https://sst.dev" + value;
    return base + value;
  };

  const walk = (node) => {
    if (node.type === "element" && node.properties) {
      for (const name of ATTRIBUTES) {
        if (name in node.properties) node.properties[name] = rewrite(node.properties[name]);
      }
    }
    // JSX in MDX, e.g. <a href="/docs/..."> or <LinkCard href="/docs/..." />
    if ((node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") && node.attributes) {
      for (const attr of node.attributes) {
        if (attr.type === "mdxJsxAttribute" && ATTRIBUTES.includes(attr.name)) attr.value = rewrite(attr.value);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };

  return walk;
}
