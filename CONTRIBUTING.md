# Development

## Contributing

We welcome contributions from the device physics community. If you're interested in joining our vibrant community building KlayoutClaw for device physicists, reach out to **caidish1234@gmail.com**.

## Setup

```bash
# Clone the repo
git clone https://github.com/caidish/KlayoutClaw.git
cd KlayoutClaw

# Install the plugin into KLayout
python install.py

# Launch KLayout
open /Applications/klayout.app

# Run tests (requires KLayout running)
python tests/test_connection.py
```

## Running Tests

```bash
# Protocol-level connection test
python tests/test_connection.py

# Functional MCP tests (phase 0-4)
pytest -m mcp tests/ -v

# Full phase-by-phase E2E regression (every phase sequentially)
bash tests/test_e2e_regression.sh

# Autoroute / Hall bar / connection E2E (individual)
bash tests/test_autoroute.sh
bash tests/test_hallbar.sh
bash tests/test_connection.sh
```

## Architecture

- **`pya.QTcpServer`** on Qt main thread — no Python threads, no GIL issues
- **No external dependencies** for the server — only Python stdlib + pya
- **`auto_route`** spawns a subprocess for heavy computation (numpy/scipy/scikit-image in conda env `instrMCPdev`)
- **`evaluate_design`** also spawns a subprocess in `instrMCPdev` (gdstk + shapely + numpy)
- **JSON-RPC 2.0** over HTTP (plain JSON, no SSE)
- `.lym` XML: escape `<` `>` `&` as `&lt;` `&gt;` `&amp;` in Python code

See [docs/plans/](docs/plans/) for design documents.
