
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
    console.log("Starting MCP Server Test...");

    const serverPath = path.resolve(__dirname, "../dist/index.js");
    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath]
    });

    const client = new Client({
        name: "test-client",
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    try {
        await client.connect(transport);
        console.log("Connected to MCP Server.");

        console.log("\n--- Testing listTools ---");
        const tools = await client.listTools();
        console.log("Available tools:", tools.tools.map(t => t.name).join(", "));

        const descCheck = tools.tools.every(t => t.description && t.description.length > 0);
        console.log("All tools have descriptions:", descCheck ? "YES" : "NO");

        console.log("\n--- Testing enumerate_devices ---");
        const devicesResult = await client.callTool({
            name: "enumerate_devices",
            arguments: {}
        });
        // @ts-ignore
        const devices = JSON.parse(devicesResult.content[0].text);
        console.log("Devices found:", devices.length);
        if (devices.length > 0) {
            console.log("First device:", devices[0]);
        }

        console.log("\n--- Testing enumerate_processes ---");
        const processesResult = await client.callTool({
            name: "enumerate_processes",
            arguments: {}
        });
        // @ts-ignore
        const rawProcessText = processesResult.content[0].text;
        console.log("Raw enumerate_processes output:", rawProcessText);
        let processes;
        try {
            processes = JSON.parse(rawProcessText);
        } catch (e) {
            console.error("Failed to parse process list using default (USB). Trying local...");
            // Fallback to local device inspection if USB fails in test
            const localResult = await client.callTool({
                name: "enumerate_processes",
                arguments: { device_id: "local" }
            });
            // @ts-ignore
            processes = JSON.parse(localResult.content[0].text);
        }
        console.log("Processes found:", processes.length);

        console.log("\n--- Testing get_process_by_name ---");
        // Try to find the game, or a system process if game not running
        let targetName = "vng.game.gunny.mobi.classic.original";
        let targetPid = 0;

        let findResult = await client.callTool({
            name: "get_process_by_name",
            arguments: { name: targetName }
        });
        // @ts-ignore
        let findData = JSON.parse(findResult.content[0].text);

        if (!findData.found) {
            console.log(`Game '${targetName}' not found, trying 'android.process.media' or 'com.android.phone'`);
            targetName = "com.android.phone"; // Fallback
            findResult = await client.callTool({
                name: "get_process_by_name",
                arguments: { name: targetName }
            });
            // @ts-ignore
            findData = JSON.parse(findResult.content[0].text);

            if (!findData.found) {
                // Final fallback - grep from list
                const p = processes.find((p: any) => p.name === "com.android.systemui");
                if (p) {
                    targetName = p.name;
                    targetPid = p.pid;
                    console.log(`Fallback to system process: ${targetName} (${targetPid})`);
                    findData = { found: true, pid: targetPid, name: targetName };
                } else {
                    console.error("Could not find any suitable process to test session.");
                    process.exit(1);
                }
            }
        }

        if (findData.found) {
            targetPid = findData.pid;
            console.log(`Target verified: ${findData.name} (PID: ${targetPid})`);

            console.log("\n--- Testing create_interactive_session ---");
            const sessionResult = await client.callTool({
                name: "create_interactive_session",
                arguments: { process_id: targetPid }
            });
            // @ts-ignore
            const sessionData = JSON.parse(sessionResult.content[0].text);
            console.log("Session creation result:", sessionData);

            if (sessionData.status === "success") {
                const sessionId = sessionData.session_id;

                console.log("\n--- Testing execute_in_session (Runtime Check) ---");
                const scriptCode = `
                    console.log("Hello from MCP Test!");
                    console.log("Runtime is: " + Script.runtime);
                    try { console.log("Java available: " + Java.available); } catch(e) { console.log("Java error: " + e.message); }
                    "RETURN_VALUE_OK";
                `;

                const execResult = await client.callTool({
                    name: "execute_in_session",
                    arguments: {
                        session_id: sessionId,
                        javascript_code: scriptCode,
                        keep_alive: false
                    }
                });
                // @ts-ignore
                const execData = JSON.parse(execResult.content[0].text);
                console.log("Execution Result:", execData);

                // Verify logs contain "V8"
                if (execData.logs && execData.logs.some((l: string) => l.includes("Runtime is: V8"))) {
                    console.log("✅ VERIFIED: Script runtime is V8");
                } else {
                    console.log("❌ WARNING: Script runtime NOT verified as V8 or logs missing");
                }

                // Verify Java availability
                if (execData.logs && execData.logs.some((l: string) => l.includes("Java available: true"))) {
                    console.log("✅ VERIFIED: Java object is available!");
                } else {
                    console.log("❌ WARNING: Java object NOT detected (check logs above)");
                }

            } else {
                console.error("Failed to create session");
            }
        }
    } catch (error) {
        console.error("Test Failed:", error);
        process.exit(1);
    }
}

main();
