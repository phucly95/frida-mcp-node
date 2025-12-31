# Frida MCP Server (Node.js)

A Model Context Protocol (MCP) server for [Frida](https://frida.re/), implemented in Node.js.  
This server provides a powerful interface for LLMs (like Claude, Gemini) to interacting with local and remote processes, enabling dynamic instrumentation, automation, and reverse engineering workflows directly from the chat interface.

## 🚀 Features

-   **Full Frida Toolkit**: 13 implemented tools covering device enumeration, process management, and script execution.
-   **V8 Runtime Support**: Explicitly enforces `runtime: 'v8'` to ensure full compatibility with `Java.perform` and Android/Java Bridge automation.
-   **Persistent Sessions**: Manages persistent Frida sessions, allowing multiple interaction steps (RPC, messaging) within the same process context.
-   **RPC & Messaging**: Full support for calling `rpc.exports` and sending/receiving messages (`send()` / `recv()`) between the LLM and the injected script.
-   **TypeScript**: Built with TypeScript for type safety and maintainability.

## 🛠️ Installation

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/phucly95/frida-mcp-node.git
    cd frida-mcp-node
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Build the project**:
    ```bash
    npm run build
    ```
    This will generate the JavaScript output in the `dist/` directory.

## ⚙️ Configuration (MCP)

Add the server to your MCP client configuration (e.g., `mcp_config.json` or Claude Desktop config):

```json
{
  "mcpServers": {
    "frida": {
      "command": "node",
      "args": [
        "/absolute/path/to/frida-mcp-node/dist/index.js"
      ]
    }
  }
}
```

> **Note**: Ensure you use the **absolute path** to the `dist/index.js` file.

## 🧰 Available Tools

This server exposes the following MCP tools:

### Device & Process Management
-   `enumerate_devices`: List all connected devices (USB, Remote, Local).
-   `enumerate_processes`: List processes on a specific device.
-   `get_process_by_name`: Find a process by name or substring.
-   `list_applications`: List installed applications on a device (Android/iOS).
-   `get_frontmost_application`: Get the application currently in the foreground.

### Execution Control
-   `spawn_process`: Spawn a new process with optional arguments/env.
-   `kill_process`: Terminate a process.
-   `resume_process`: Resume a paused process.

### Session & Scripting
-   `create_interactive_session`: Attach to a process and create a persistent session.
-   `execute_in_session`: Inject and execute JavaScript code (V8 runtime).
-   `get_session_messages`: Retrieve console logs and messages from the script.
-   `call_script_function`: Call an exported function (`rpc.exports`) from the script.
-   `post_message_to_session`: Send a JSON message to Key script (handled by `recv()`).

## 🧪 Usage Example

**Scenario: Automating an Android App**

1.  **List Devices**: `enumerate_devices()` -> Found `emulator-5554`.
2.  **Spawn App**: `spawn_process("com.example.game", ["--arg1"], {}, "emulator-5554")`.
3.  **Create Session**: `create_interactive_session(PID, "emulator-5554")`.
4.  **Inject Script**:
    ```javascript
    execute_in_session(SESSION_ID, `
        Java.perform(function() {
            var MainActivity = Java.use("com.example.game.MainActivity");
            MainActivity.login.implementation = function() {
                console.log("Login intercepted!");
                this.login();
            };
        });
    `, true) // keep_alive = true
    ```
5.  **Check Logs**: `get_session_messages(SESSION_ID)`.

## 🤝 Contributing

Pull requests are welcome! Please ensure any new tools are covered by the verification suite (`test/verify_full_suite.ts`).

## 📜 License

MIT
