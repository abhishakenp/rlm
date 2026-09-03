"""Web search skill — CLI entry point."""

from .websearch import run as _run
import asyncio
import sys


async def cli():
    """Entry point for the websearch command."""
    args = sys.argv[1:]
    if not args:
        print("Usage: websearch <query>", file=sys.stderr)
        sys.exit(1)
    
    query = " ".join(args)
    result = await _run(query)
    print(result)


if __name__ == "__main__":
    asyncio.run(cli())
