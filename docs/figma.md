# Figma References

`peye` can use a Figma node URL as the reference input for `peye compare`.

## Supported Sources

When `--reference` is a Figma URL, `peye` can resolve the image through:

- Figma desktop MCP
- remote Figma MCP
- Figma REST API

By default, the tool tries them in this order:

1. desktop MCP
2. remote MCP
3. REST

## Environment Variables

| Variable                     | Default                     | Purpose                                          |
| ---------------------------- | --------------------------- | ------------------------------------------------ |
| `PEYE_FIGMA_SOURCE`          | `auto`                      | Force source selection: `auto`, `mcp`, or `rest` |
| `PEYE_FIGMA_MCP_DESKTOP_URL` | `http://127.0.0.1:3845/mcp` | Override the local Figma desktop MCP endpoint    |
| `PEYE_FIGMA_MCP_REMOTE_URL`  | `https://mcp.figma.com/mcp` | Override the remote Figma MCP endpoint           |
| `FIGMA_TOKEN`                | none                        | Required for REST mode and REST fallback         |
| `FIGMA_API_BASE_URL`         | `https://api.figma.com`     | Override the Figma REST API base URL             |

## Typical Usage

Default source selection:

```bash
peye compare \
  --preview http://localhost:3000/#hero \
  --reference "https://www.figma.com/design/FILE_KEY/Mockup?node-id=1-2" \
  --viewport 1920 \
  --output ./peye-output
```

Force REST explicitly, for example in CI:

```bash
PEYE_FIGMA_SOURCE=rest \
FIGMA_TOKEN=your_token_here \
peye compare \
  --preview http://localhost:3000/#hero \
  --reference "https://www.figma.com/design/FILE_KEY/Mockup?node-id=1-2" \
  --viewport 1920 \
  --output ./peye-output
```

## Behavior Notes

- The Figma URL must include `node-id`.
- In `auto` mode, `peye` prefers MCP before REST.
- If MCP returns a screenshot that is smaller than the selected node metadata dimensions, `peye` automatically rescales the reference back to the node size before diffing.
- If you need a strict exported raster from Figma, force REST with `PEYE_FIGMA_SOURCE=rest`.

## Troubleshooting

If Figma reference resolution fails, the usual fixes are:

1. Start the Figma desktop app MCP server.
2. Run `peye` in an interactive terminal to authorize remote Figma MCP.
3. Set `FIGMA_TOKEN` so REST can be used.
