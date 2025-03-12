import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  CallToolResultSchema,
  ReadResourceResultSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import EventEmitter from "events";
import logger from "./utils/logger.js";
import {
  ConnectionError,
  ToolError,
  ResourceError,
  wrapError,
} from "./utils/errors.js";

export class MCPConnection extends EventEmitter {
  constructor(name, config) {
    super();
    this.name = name;
    this.config = config;
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.resources = [];
    this.resourceTemplates = [];
    this.status = config.disabled ? "disabled" : "disconnected"; // disabled | disconnected | connecting | connected
    this.error = null;
    this.startTime = null;
    this.lastStarted = null;
    this.disabled = config.disabled || false;
  }

  async start() {
    // If disabled, enable it
    if (this.disabled) {
      this.disabled = false;
      this.config.disabled = false;
      this.status = "disconnected";
    }

    // If already connected, return current state
    if (this.status === "connected") {
      return this.getServerInfo();
    }

    await this.connect();
    return this.getServerInfo();
  }

  async stop(disable = false) {
    if (disable) {
      this.disabled = true;
      this.config.disabled = true;
    }

    // if (this.status !== "disconnected") {
    await this.disconnect();
    // }

    return this.getServerInfo();
  }

  // Calculate uptime in seconds
  getUptime() {
    if (!this.startTime || !["connected", "disabled"].includes(this.status)) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  async connect() {
    try {
      if (this.disabled) {
        this.status = "disabled";
        this.startTime = Date.now(); // Track uptime even when disabled
        this.lastStarted = new Date().toISOString();
        return;
      }

      this.error = null;
      this.status = "connecting";
      this.lastStarted = new Date().toISOString();

      this.client = new Client(
        {
          name: "mcp-hub",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      const env = this.config.env || {};

      // For each key in env, use process.env as fallback if value is falsy
      // This means empty string, null, undefined etc. will fall back to process.env value
      // Example: { API_KEY: "" } or { API_KEY: null } will use process.env.API_KEY
      Object.keys(env).forEach((key) => {
        env[key] = env[key] ? env[key] : process.env[key];
      });

      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
        env: {
          ...env,
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        },
        stderr: "pipe",
      });
      // logger.error("TEST", "env message", process.env, false);

      // Handle transport errors
      this.transport.onerror = (error) => {
        const connectionError = new ConnectionError(
          "Failed to communicate with server",
          {
            server: this.name,
            error: error.message,
          }
        );
        logger.error(
          connectionError.code,
          connectionError.message,
          connectionError.data,
          false
        );
        this.error = error.message;
        this.status = "disconnected";
        this.startTime = null;
      };

      this.transport.onclose = () => {
        logger.info(`Transport connection closed for server '${this.name}'`, {
          server: this.name,
        });
        this.status = "disconnected";
        this.startTime = null;
      };

      // Set up stderr handling before connecting
      const stderrStream = this.transport.stderr;
      if (stderrStream) {
        stderrStream.on("data", (data) => {
          const errorOutput = data.toString();
          const error = new ConnectionError("Server error output", {
            server: this.name,
            error: errorOutput,
          });
          logger.error(error.code, error.message, error.data, false);
          this.error = errorOutput;
        });
      }

      // Connect client (this will start the transport)
      await this.client.connect(this.transport);

      // Fetch initial capabilities before marking as connected
      await this.updateCapabilities();

      // Set up notification handlers
      this.setupNotificationHandlers();

      // Only mark as connected after capabilities are fetched
      this.status = "connected";
      this.startTime = Date.now();
      this.error = null;

      logger.info(`'${this.name}' MCP server connected`, {
        server: this.name,
        tools: this.tools.length,
        resources: this.resources.length,
      });
    } catch (error) {
      // Ensure proper cleanup on error
      await this.disconnect(error.message);

      throw new ConnectionError(
        `Failed to connect to "${this.name}" MCP server: ${error.message}`,
        {
          server: this.name,
          error: error.message,
        }
      );
    }
  }

  setupNotificationHandlers() {
    // Handle tool list changes
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        logger.debug(
          `Received tools list changed notification from ${this.name}`
        );
        await this.updateCapabilities();
        this.emit("toolsChanged", {
          server: this.name,
          tools: this.tools,
        });
      }
    );

    // Handle resource list changes
    this.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        logger.debug(
          `Received resources list changed notification from ${this.name}`
        );
        await this.updateCapabilities();
        this.emit("resourcesChanged", {
          server: this.name,
          resources: this.resources,
          resourceTemplates: this.resourceTemplates,
        });
      }
    );

    // Handle general logging messages
    this.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        logger.debug("[server log]:", notification.params.data);
      }
    );
  }

  async updateCapabilities() {
    //skip for disabled servers
    if (!this.client) {
      return;
    }
    // Helper function to safely request capabilities
    const safeRequest = async (method, schema) => {
      try {
        const response = await this.client.request({ method }, schema);
        return response;
      } catch (error) {
        logger.debug(
          `Server '${this.name}' does not support capability '${method}'`,
          {
            server: this.name,
            error: error.message,
          }
        );
        return null;
      }
    };

    try {
      // Fetch all capabilities before updating state
      const [templatesResponse, toolsResponse, resourcesResponse] =
        await Promise.all([
          safeRequest(
            "resources/templates/list",
            ListResourceTemplatesResultSchema
          ),
          safeRequest("tools/list", ListToolsResultSchema),
          safeRequest("resources/list", ListResourcesResultSchema),
        ]);

      // Update local state atomically, defaulting to empty arrays if capability not supported
      this.resourceTemplates = templatesResponse?.resourceTemplates || [];
      this.tools = toolsResponse?.tools || [];
      this.resources = resourcesResponse?.resources || [];

      // logger.info(`Updated capabilities for server '${this.name}'`, {
      //   server: this.name,
      //   toolCount: this.tools.length,
      //   resourceCount: this.resources.length,
      //   templateCount: this.resourceTemplates.length,
      //   supportedCapabilities: {
      //     tools: !!toolsResponse,
      //     resources: !!resourcesResponse,
      //     resourceTemplates: !!templatesResponse,
      //   },
      // });
    } catch (error) {
      // Only log as warning since missing capabilities are expected in some cases
      logger.warn(`Error updating capabilities for server '${this.name}'`, {
        server: this.name,
        error: error.message,
      });

      // Reset capabilities to empty arrays
      this.resourceTemplates = [];
      this.tools = [];
      this.resources = [];
    }
  }

  /*
  * | Scenario            | Example Response                                                                 |
    |---------------------|----------------------------------------------------------------------------------|
    | Text Output         | `{ "content": [{ "type": "text", "text": "Hello, World!" }], "isError": false }` |
    | Image Output        | `{ "content": [{ "type": "image", "data": "base64data...", "mimeType": "image/png" }], "isError": false }` |
    | Text Resource       | `{ "content": [{ "type": "resource", "resource": { "uri": "file.txt", "text": "Content" } }], "isError": false }` |
    | Binary Resource     | `{ "content": [{ "type": "resource", "resource": { "uri": "image.jpg", "blob": "base64data...", "mimeType": "image/jpeg" } }], "isError": false }` |
    | Error Case          | `{ "content": [], "isError": true }` (Note: Error details might be in JSON-RPC level) |
    */
  async callTool(toolName, args) {
    if (!this.client) {
      throw new ToolError("Server not initialized", {
        server: this.name,
        tool: toolName,
      });
    }

    if (this.status !== "connected") {
      throw new ToolError("Server not connected", {
        server: this.name,
        tool: toolName,
        status: this.status,
      });
    }

    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new ToolError("Tool not found", {
        server: this.name,
        tool: toolName,
        availableTools: this.tools.map((t) => t.name),
      });
    }

    //check args, it should be either a list or an object or null
    if (args && !Array.isArray(args) && typeof args !== "object") {
      throw new ToolError("Invalid arguments", {
        server: this.name,
        tool: toolName,
        args,
      });
    }

    try {
      return await this.client.request(
        {
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        },
        CallToolResultSchema
      );
    } catch (error) {
      throw wrapError(error, "TOOL_EXECUTION_ERROR", {
        server: this.name,
        tool: toolName,
        args,
      });
    }
  }

  /*
  * | Scenario                     | Example Response                                                                 |
    |------------------------------|----------------------------------------------------------------------------------|
    | Text Resource                | `{ "contents": [{ "uri": "file.txt", "text": "This is the content of the file." }] }` |
    | Binary Resource without `mimeType` | `{ "contents": [{ "uri": "image.jpg", "blob": "base64encodeddata..." }] }`         |
    | Binary Resource with `mimeType` | `{ "contents": [{ "uri": "image.jpg", "mimeType": "image/jpeg", "blob": "base64encodeddata..." }] }` |
    | Multiple Resources           | `{ "contents": [{ "uri": "file1.txt", "text": "Content of file1" }, { "uri": "file2.png", "blob": "base64encodeddata..." }] }` |
    | No Resources (empty)         | `{ "contents": [] }`                                                             |
  */

  async readResource(uri) {
    if (!this.client) {
      throw new ResourceError("Server not initialized", {
        server: this.name,
        uri,
      });
    }

    if (this.status !== "connected") {
      throw new ResourceError("Server not connected", {
        server: this.name,
        uri,
        status: this.status,
      });
    }

    const isValidResource =
      this.resources.some((r) => r.uri === uri) ||
      this.resourceTemplates.some((t) => {
        // Convert template to regex pattern
        const pattern = t.uriTemplate.replace(/\{[^}]+\}/g, "[^/]+");
        return new RegExp(`^${pattern}$`).test(uri);
      });

    if (!isValidResource) {
      throw new ResourceError("Resource not found", {
        server: this.name,
        uri,
        availableResources: this.resources.map((r) => r.uri),
        availableTemplates: this.resourceTemplates.map((t) => t.uriTemplate),
      });
    }

    try {
      return await this.client.request(
        {
          method: "resources/read",
          params: { uri },
        },
        ReadResourceResultSchema
      );
    } catch (error) {
      throw wrapError(error, "RESOURCE_READ_ERROR", {
        server: this.name,
        uri,
      });
    }
  }

  async resetState(error) {
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.resources = [];
    this.resourceTemplates = [];
    this.status = this.config.disabled ? "disabled" : "disconnected"; // disabled | disconnected | connecting | connected
    this.error = error || null;
    this.startTime = null;
    this.lastStarted = null;
    this.disabled = this.config.disabled || false;
  }

  async disconnect(error) {
    if (this.transport) {
      await this.transport.close();
    }
    if (this.client) {
      await this.client.close();
    }
    this.resetState(error);
  }

  getServerInfo() {
    return {
      name: this.name,
      status: this.status,
      error: this.error,
      capabilities: {
        tools: this.tools,
        resources: this.resources,
        resourceTemplates: this.resourceTemplates,
      },
      uptime: this.getUptime(),
      lastStarted: this.lastStarted,
    };
  }
}
