#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config";
import { createServer } from "./server";

const config = await loadConfig(process.env);
serveStdio(() => createServer(config));
