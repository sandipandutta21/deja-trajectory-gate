// A deliberately deterministic stand-in for a real agent, so deja's own CI can gate it on
// every PR without depending on a live LLM. It exercises exactly the workflow documented in
// the README's "Trajectory Gate" section: read DEJA_MCP_URL, make the same two calls every
// time, exit 0.
async function call(url, id, method, params) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
    return body.result;
}

async function main() {
    const url = process.env.DEJA_MCP_URL;
    if (!url) throw new Error("DEJA_MCP_URL not set -- expected to be run under `deja gate`");

    await call(url, 1, "tools/list");
    await call(url, 2, "tools/call", { name: "lookup_customer", customerId: "c-42" });
}

main().then(
    () => process.exit(0),
    (err) => {
        console.error(err);
        process.exit(1);
    }
);
