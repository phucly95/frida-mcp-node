#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as frida from "frida";
import { Device, Session, Script, SpawnOptions, ScriptRuntime } from "frida";

// --- Session Management ---
interface ActiveSession {
    session: Session;
    scripts: Map<string, Script>;
    messageQueue: any[];
    id: string;
}

const sessions = new Map<string, ActiveSession>();

class SessionManager {
    static async create(processId: number, deviceId?: string): Promise<string> {
        const device = deviceId ? await frida.getDevice(deviceId) : await frida.getUsbDevice();
        const session = await device.attach(processId);
        const sessionId = `session_${processId}_${Date.now()}`;

        sessions.set(sessionId, {
            session,
            scripts: new Map(),
            messageQueue: [],
            id: sessionId
        });

        // Detach handler
        session.detached.connect((reason) => {
            console.error(`Session ${sessionId} detached: ${reason}`);
            sessions.delete(sessionId);
        });

        return sessionId;
    }

    static get(sessionId: string): ActiveSession | undefined {
        return sessions.get(sessionId);
    }

    static async execute(sessionId: string, code: string, keepAlive: boolean): Promise<any> {
        const activeSession = this.get(sessionId);
        if (!activeSession) throw new Error(`Session ${sessionId} not found`);

        // Wrapper to capture console.log and return logic
        const wrappedCode = `
        (function() {
            var logs = [];
            var originalLog = console.log;
            console.log = function() {
                var args = Array.prototype.slice.call(arguments);
                var logMsg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
                logs.push(logMsg);
                originalLog.apply(console, arguments);
            };

            var result;
            var error;
            try {
                result = eval(${JSON.stringify(code)});
            } catch(e) {
                error = { message: e.toString(), stack: e.stack };
            }

            console.log = originalLog;
            send({ type: 'execution_receipt', result: result, error: error, logs: logs });
        })();
        `;

        // CRITICAL FIX: explicitly use 'v8' runtime
        const script = await activeSession.session.createScript(wrappedCode, { runtime: 'v8' as ScriptRuntime });

        return new Promise((resolve, reject) => {
            let handled = false;

            const onMessage = (message: any, data: Buffer | null) => {
                if (message.type === 'send') {
                    const payload = message.payload;
                    if (payload.type === 'execution_receipt') {
                        if (!handled) {
                            handled = true;
                            if (keepAlive) {
                                // Keep script alive for further hooks
                                const scriptId = Math.random().toString(36).substring(7);
                                activeSession.scripts.set(scriptId, script);
                                // Re-bind message handler for persistent logging to queue
                                script.message.disconnect(onMessage);
                                script.message.connect((msg, d) => {
                                    activeSession.messageQueue.push({ message: msg, data: d });
                                });
                            } else {
                                script.unload();
                            }

                            resolve({
                                status: payload.error ? 'error' : 'success',
                                result: payload.result,
                                error: payload.error,
                                logs: payload.logs
                            });
                        }
                    } else if (keepAlive) {
                        activeSession.messageQueue.push({ message, data });
                    }
                } else if (message.type === 'error') {
                    if (!handled) {
                        handled = true;
                        resolve({ status: 'error', error: message.description, details: message });
                    }
                }
            };

            script.message.connect(onMessage);
            script.load().catch(err => {
                if (!handled) reject(err);
            });
        });
    }
}

// --- Server Setup ---
const mcpServer = new McpServer(
    {
        name: "frida-mcp-node",
        version: "1.0.0"
    },
    {
        capabilities: {
            tools: {} // Capability declaration
        }
    }
);

// --- Tool Registration ---

// Helper to format text content
const formatText = (data: any) => ({
    content: [{ type: "text" as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
});

// 1. Enumerate Devices
mcpServer.registerTool(
    "enumerate_devices",
    {
        description: "List all connected devices (USB, Local, Remote).",
        inputSchema: z.object({})
    },
    async () => {
        const devices = await frida.enumerateDevices();
        return formatText(devices.map(d => ({
            id: d.id,
            name: d.name,
            type: d.type
        })));
    }
);

// 2. Enumerate Processes
mcpServer.registerTool(
    "enumerate_processes",
    {
        description: "List processes running on a specific device.",
        inputSchema: z.object({
            device_id: z.string().optional().describe("Device ID to list processes from. Defaults to USB device.")
        })
    },
    async ({ device_id }) => {
        const device = device_id ? await frida.getDevice(device_id) : await frida.getUsbDevice();
        const processes = await device.enumerateProcesses();
        return formatText(processes.map(p => ({
            pid: p.pid,
            name: p.name
        })));
    }
);

// 3. Get Process By Name
mcpServer.registerTool(
    "get_process_by_name",
    {
        description: "Find a process by its name (case-insensitive substring match).",
        inputSchema: z.object({
            name: z.string().describe("Process name or substring to search for."),
            device_id: z.string().optional().describe("Device ID to search on. Defaults to USB.")
        })
    },
    async ({ name, device_id }) => {
        const device = device_id ? await frida.getDevice(device_id) : await frida.getUsbDevice();
        const processes = await device.enumerateProcesses();
        const match = processes.find(p => p.name.toLowerCase().includes(name.toLowerCase()));

        if (match) {
            return formatText({ found: true, pid: match.pid, name: match.name });
        } else {
            return formatText({ found: false, error: "Not found" });
        }
    }
);

// 4. Spawn Process
mcpServer.registerTool(
    "spawn_process",
    {
        description: "Spawn a new process/application.",
        inputSchema: z.object({
            program: z.string().describe("Package name or path to executable."),
            argv: z.array(z.string()).optional().describe("Command line arguments."),
            env: z.record(z.string()).optional().describe("Environment variables."),
            device_id: z.string().optional().describe("Device ID to spawn on.")
        })
    },
    async ({ program, argv, env, device_id }) => {
        const device = device_id ? await frida.getDevice(device_id) : await frida.getUsbDevice();
        // Construct SpawnOptions
        const options: SpawnOptions = {};
        if (argv) options.argv = [program, ...argv]; // Frida expects argv[0] to be the program usually
        if (env) options.env = env;

        const pid = await device.spawn(program, options);
        return formatText({ pid });
    }
);

// 5. Resume Process
mcpServer.registerTool(
    "resume_process",
    {
        description: "Resume a paused process (e.g., after spawning).",
        inputSchema: z.object({
            pid: z.number().describe("Process ID to resume."),
            device_id: z.string().optional().describe("Device ID.")
        })
    },
    async ({ pid, device_id }) => {
        const device = device_id ? await frida.getDevice(device_id) : await frida.getUsbDevice();
        await device.resume(pid);
        return formatText({ success: true, pid });
    }
);

// 6. Kill Process
mcpServer.registerTool(
    "kill_process",
    {
        description: "Terminate a process.",
        inputSchema: z.object({
            pid: z.number().describe("Process ID to kill."),
            device_id: z.string().optional().describe("Device ID.")
        })
    },
    async ({ pid, device_id }) => {
        const device = device_id ? await frida.getDevice(device_id) : await frida.getUsbDevice();
        await device.kill(pid);
        return formatText({ success: true, pid });
    }
);

// 7. Create Session
mcpServer.registerTool(
    "create_interactive_session",
    {
        description: "Attach to a process and create a persistent Frida session.",
        inputSchema: z.object({
            process_id: z.number().describe("Target Process ID."),
            device_id: z.string().optional().describe("Device ID.")
        })
    },
    async ({ process_id, device_id }) => {
        try {
            const sessionId = await SessionManager.create(process_id, device_id);
            return formatText({
                status: "success",
                session_id: sessionId,
                message: "Session created. Use execute_in_session."
            });
        } catch (e: any) {
            return {
                content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: e.toString() }) }],
                isError: true
            };
        }
    }
);

// 8. Execute in Session
mcpServer.registerTool(
    "execute_in_session",
    {
        description: "Execute JavaScript in an active session (Enforces V8 runtime).",
        inputSchema: z.object({
            session_id: z.string().describe("Session ID from create_interactive_session."),
            javascript_code: z.string().describe("Frida JavaScript code."),
            keep_alive: z.boolean().optional().default(false).describe("Keep script loaded for hooks?")
        })
    },
    async ({ session_id, javascript_code, keep_alive }) => {
        try {
            const result = await SessionManager.execute(session_id, javascript_code, keep_alive);
            return formatText(result);
        } catch (e: any) {
            return {
                content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: e.toString() }) }],
                isError: true
            };
        }
    }
);

// 9. Get Messages
mcpServer.registerTool(
    "get_session_messages",
    {
        description: "Retrieve logs/messages from a persistent script.",
        inputSchema: z.object({
            session_id: z.string().describe("Session ID.")
        })
    },
    async ({ session_id }) => {
        const session = SessionManager.get(session_id);
        if (!session) return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: "Session not found" }) }],
            isError: true
        };

        const messages = [...session.messageQueue];
        session.messageQueue = []; // Clear queue
        return formatText({ status: "success", messages });
    }
);

// 10. List Applications
mcpServer.registerTool(
    "list_applications",
    {
        description: "List installed applications on the device.",
        inputSchema: z.object({
            device_id: z.string().optional().describe("Device ID.")
        })
    },
    async ({ device_id }) => {
        const device = device_id ? await frida.getDevice(device_id) : await frida.getUsbDevice();
        // enumerateApplications allows filtering but we'll list all/identifiers
        const apps = await device.enumerateApplications();
        return formatText(apps.map(a => ({
            identifier: a.identifier,
            name: a.name,
            pid: a.pid,
            parameters: a.parameters
        })));
    }
);

// 11. Get Frontmost Application
mcpServer.registerTool(
    "get_frontmost_application",
    {
        description: "Get the application currently visible on screen.",
        inputSchema: z.object({
            device_id: z.string().optional().describe("Device ID.")
        })
    },
    async ({ device_id }) => {
        const device = device_id ? await frida.getDevice(device_id) : await frida.getUsbDevice();
        const app = await device.getFrontmostApplication();
        if (!app) return formatText(null);
        return formatText({
            identifier: app.identifier,
            name: app.name,
            pid: app.pid,
            parameters: app.parameters
        });
    }
);

// 12. Call Script Function (RPC)
mcpServer.registerTool(
    "call_script_function",
    {
        description: "Call an exported function from the Frida script (RPC).",
        inputSchema: z.object({
            session_id: z.string().describe("Session ID."),
            function_name: z.string().describe("Name of the exported function to call."),
            args: z.array(z.any()).optional().default([]).describe("Arguments to pass to the function.")
        })
    },
    async ({ session_id, function_name, args }) => {
        const session = SessionManager.get(session_id);
        if (!session) return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: "Session not found" }) }],
            isError: true
        };

        // We assume the last created script is the "main" one or the user should specify (but simple is best)
        // For simplicity, we use the most recent script in the session
        const scriptKeys = Array.from(session.scripts.keys());
        if (scriptKeys.length === 0) return formatText({ status: "error", error: "No active scripts in session" });
        const script = session.scripts.get(scriptKeys[scriptKeys.length - 1]);

        if (!script) return formatText({ status: "error", error: "Script instance missing" });

        try {
            // Access exports
            const api = script.exports;
            if (typeof api[function_name] !== 'function') {
                return formatText({ status: "error", error: `Function '${function_name}' not found in exports` });
            }
            const result = await api[function_name](...args);
            return formatText({ status: "success", result });
        } catch (e: any) {
            return formatText({ status: "error", error: e.toString() });
        }
    }
);

// 13. Post Message to Session
mcpServer.registerTool(
    "post_message_to_session",
    {
        description: "Post a JSON message to the script (received by recv() in Frida).",
        inputSchema: z.object({
            session_id: z.string().describe("Session ID."),
            message: z.any().describe("JSON message content.")
        })
    },
    async ({ session_id, message }) => {
        const session = SessionManager.get(session_id);
        if (!session) return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: "Session not found" }) }],
            isError: true
        };

        const scriptKeys = Array.from(session.scripts.keys());
        if (scriptKeys.length === 0) return formatText({ status: "error", error: "No active scripts in session" });
        const script = session.scripts.get(scriptKeys[scriptKeys.length - 1]);

        if (!script) return formatText({ status: "error", error: "Script instance missing" });

        try {
            await script.post(message);
            return formatText({ status: "success", sent: true });
        } catch (e: any) {
            return formatText({ status: "error", error: e.toString() });
        }
    }
);

// --- Connect ---
async function main() {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
}

main().catch(console.error);
