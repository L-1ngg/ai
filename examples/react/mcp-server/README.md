# MCP server

You want a host to call your tools, a file, and a prompt. This app serves all three over MCP.

## Run it

1. From the repo root, run `pnpm install`.
2. Run `pnpm --filter mcp-server dev`.
3. Open http://localhost:3100.
4. Click Call the server.

The forecast, the city guide, and the trip brief come from the MCP server.

The server is `src/mcp-server.ts`. The route is `src/routes/api.mcp.ts`. The page is `src/routes/index.tsx`.
