"""Talk to the open Blender through Blender Lab's MCP bridge (localhost:9876).

Run with the Python that has the `mcp` package (the BlenderMCP venv):
    C:\\Users\\PC\\Desktop\\BlenderMCP\\venv\\Scripts\\python.exe tools/blender_live.py code  <file.py | -c "python code">
    C:\\Users\\PC\\Desktop\\BlenderMCP\\venv\\Scripts\\python.exe tools/blender_live.py shot  <out.png>
    C:\\Users\\PC\\Desktop\\BlenderMCP\\venv\\Scripts\\python.exe tools/blender_live.py tools

`code` runs Python inside Blender and prints its stdout and result.
`shot` saves a screenshot of the Blender window.
"""
import asyncio
import base64
import json
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER = r"C:\Users\PC\Desktop\BlenderMCP\venv\Scripts\blender-mcp.exe"


async def main(argv: list[str]) -> int:
    async with stdio_client(StdioServerParameters(command=SERVER, args=[])) as (read, write):
        async with ClientSession(read, write) as s:
            await s.initialize()
            if argv[0] == "tools":
                for t in (await s.list_tools()).tools:
                    print(t.name, json.dumps(t.inputSchema.get("properties", {}))[:300])
                return 0
            if argv[0] == "code":
                code = argv[2] if argv[1] == "-c" else open(argv[1], encoding="utf-8").read()
                res = await s.call_tool("execute_blender_code", {"code": code})
                for part in res.content:
                    print(getattr(part, "text", part))
                return 1 if res.isError else 0
            if argv[0] == "shot":
                res = await s.call_tool("get_screenshot_of_window_as_image", {})
                for part in res.content:
                    if getattr(part, "type", "") == "image":
                        open(argv[1], "wb").write(base64.b64decode(part.data))
                        print("saved", argv[1])
                        return 0
                    print(getattr(part, "text", part))
                return 1
    return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
