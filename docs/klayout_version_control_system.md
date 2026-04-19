**KLayout Git (klayout-vc)**  
*Version Control System for Integrated Circuit Layouts*

---

## 1. Vision & Objectives

### 1.1 Product Vision

Bring software-style version control (Git-like semantics) natively into the layout editing workflow. Instead of treating GDSII as opaque binary artifacts, treat layouts as source code—editable, diffable, and historically traceable within the design environment.

**Core Value Proposition**: Designers should be able to checkpoint work, explore alternative routing strategies in branches, and visually compare geometric differences without leaving KLayout or managing external scripts.

### 1.2 Success Criteria

- **Zero-friction adoption**: Opening a `.gds` file automatically detects or initializes version control
- **Transparent persistence**: Saving the layout synchronizes both the binary GDSII and the version history
- **Visual history**: Users can browse past states graphically, not through opaque commit hashes
- **Agent-ready**: AI agents can programmatically navigate design history, branch experiments, and rollback via MCP

---

## 2. User Stories & Use Cases

### 2.1 The Designer (Primary User)

**Story 1: The Experiment**
> "I'm trying two different power grid strategies. I want to checkpoint the baseline, try Strategy A, go back to baseline, try Strategy B, then visually compare which has better density."

Requirements implied:
- Named checkpoints with semantic meaning
- Non-linear history navigation (jump to any past state)
- Side-by-side or overlay comparison of geometric differences
- Branch isolation (Strategy A doesn't contaminate Strategy B)

**Story 2: The Morning After**
> "Yesterday I routed the clock tree and went home. Today I see timing issues—I need to see exactly what changed between yesterday's 6pm checkpoint and now."

Requirements implied:
- Automatic checkpointing on save or time-based
- Diff visualization showing added/removed/moved geometry
- Rollback capability with change preview

**Story 3: The Milestone**
> "The PD is clean. I want to tag this state as 'MPW-Submission-Candidate' and continue experimenting, knowing I can always return to this exact geometry."

Requirements implied:
- Named tags/labels for specific commits
- Read-only checkout of historical states
- Branch creation from milestones to preserve clean baselines

### 2.2 The AI Agent (Secondary User)

**Story 4: The Optimization Loop**
> "Agent iteratively places components and evaluates area. After each iteration, it checkpoints. If iteration 7 makes area worse, agent automatically rolls back to iteration 5."

Requirements implied:
- MCP tools for checkpoint, list-history, checkout, diff
- Programmatic access to geometric statistics (bounding box deltas, element counts)
- Deterministic reconstruction (re-generate exact GDS from history)

**Story 5: The Code Generation**
> "Agent exports the current layout as Python code (pya or gdsfactory) so it can be archived as human-readable source rather than binary."

Requirements implied:
- Export current or historical state as executable Python script
- Round-trip fidelity: generated code recreates identical geometry

---

## 3. Functional Requirements

### 3.1 Core Version Control

| ID | Requirement | Priority |
|----|-------------|----------|
| VC-1 | **Automatic Repository Detection**: Opening a `.gds` file shall automatically detect adjacent version control repository (`.gds.vc/`) or initialize transient in-memory history | P0 |
| VC-2 | **Checkpoint Creation**: User can create named checkpoints (commits) at any time via hotkey or menu. Each checkpoint captures complete layout state | P0 |
| VC-3 | **History Browser**: Visual panel showing chronological history with messages, timestamps, and preview thumbnails | P0 |
| VC-4 | **Checkout**: User can restore any historical checkpoint, replacing current memory state. Unsaved changes trigger warning dialog | P0 |
| VC-5 | **Branch Management**: Create named branches from any point, switch between branches, merge branches with conflict detection | P1 |
| VC-6 | **Tags**: Assign human-readable labels to specific checkpoints (e.g., "Tapeout-Ready", "Pre-PEX") | P1 |
| VC-7 | **Diff Visualization**: Visual comparison between any two checkpoints showing geometric changes (added/removed regions highlighted) | P0 |

### 3.2 Data Management

| ID | Requirement | Priority |
|----|-------------|----------|
| DM-1 | **Deterministic Serialization**: Same layout must always produce identical text representation (bit-for-bit) to enable meaningful diffs | P0 |
| DM-2 | **GDSII ↔ Text Round-trip**: Lossless conversion between KLayout memory, GDSII binary, and text representation | P0 |
| DM-3 | **Code Generation**: Export any historical state as executable Python code (pya format) that reconstructs the layout | P1 |
| DM-4 | **Transient-to-Persistent Migration**: Memory-based history automatically converts to disk-based repository upon first file save | P0 |
| DM-5 | **Crash Recovery**: Detect and offer to recover unsaved checkpoint history after unexpected shutdown | P1 |

### 3.3 Integration & Interface

| ID | Requirement | Priority |
|----|-------------|----------|
| UI-1 | **Status Indication**: Toolbar/status bar shows current branch, modification status, and last checkpoint time | P0 |
| UI-2 | **Checkpoint Dialog**: Simple modal for entering checkpoint message with optional tags | P0 |
| UI-3 | **History Panel**: Dockable panel showing commit graph (linear or DAG), searchable by message content | P0 |
| UI-4 | **Save Integration**: Native KLayout save operation triggers automatic checkpoint (configurable) | P0 |
| UI-5 | **Context Menus**: Right-click on layout background for quick checkpoint; right-click on history items for checkout/branch/merge | P1 |

### 3.4 MCP Agent Interface

| ID | Requirement | Priority |
|----|-------------|----------|
| MCP-1 | **Initialize**: Agent can initialize VC mode (memory or disk) for current layout | P0 |
| MCP-2 | **Checkpoint**: Agent creates checkpoints with programmatic messages and tags | P0 |
| MCP-3 | **History Query**: Agent retrieves commit history with metadata (timestamps, messages, change statistics) | P0 |
| MCP-4 | **Checkout**: Agent can checkout specific commits or branches by reference | P0 |
| MCP-5 | **Diff Analysis**: Agent retrieves structured diff data (cell changes, layer statistics, bounding box deltas) | P0 |
| MCP-6 | **Branch Operations**: Agent can list, create, switch, and merge branches | P1 |
| MCP-7 | **Export**: Agent exports current or historical state as Python code or GDS file | P1 |
| MCP-8 | **Status**: Agent queries current state (branch, dirty status, pending checkpoints) | P0 |

---

## 4. Non-Functional Requirements

### 4.1 Performance

- **Checkpoint Latency**: Creating a checkpoint for layouts up to 100MB GDSII should complete within 2 seconds
- **History Load**: History browser should populate within 1 second for repositories with <100 checkpoints
- **Checkout**: Switching between checkpoints should be visually responsive (<1s for layout reload)

### 4.2 Reliability

- **Data Integrity**: Zero tolerance for geometry loss during round-trip conversion
- **Atomic Operations**: Checkpoint creation is atomic—corrupted checkpoints cannot leave repository in inconsistent state
- **Graceful Degradation**: If VC operations fail, KLayout continues functioning as normal editor

### 4.3 Usability

- **Zero Configuration**: Works out-of-the-box; no manual Git setup required
- **Non-blocking**: Background processing for expensive operations (diff rendering, serialization)
- **Discoverability**: Visual indicators make version control status obvious

---

## 5. System Boundaries & Constraints

### 5.1 Scope Inclusions

- Single-user, single-machine workflow (no multi-user concurrency)
- Standard GDSII primitives: polygons (with holes), paths, text, cell references (SREF), array references (AREF)
- KLayout Python API-based implementation
- Git-compatible storage format (allowing external Git tools if needed)

### 5.2 Scope Exclusions

- Multi-user concurrent editing (file locking only, no real-time collaboration)
- Remote repository operations (push/pull to GitHub/GitLab—external Git client can be used)
- Binary diff/merge for overlapping geometry (conflicts detected, manual resolution required)
- OASIS format primary support (GDSII primary; OASIS via conversion)

### 5.3 Assumptions

- KLayout 0.28+ with stable Python API
- Sufficient RAM to hold layout + history in memory (target <500MB layouts)
- Local filesystem permissions for sidecar directory creation

---

## 6. Acceptance Criteria (E2E)

### 6.1 Lifecycle Testing

**Test: New Layout Workflow**
1. User creates new layout in KLayout
2. User adds geometric shapes
3. User presses checkpoint hotkey, enters message
4. System stores checkpoint in memory
5. User saves file to disk
6. System creates persistent repository alongside file
7. User closes and reopens file
8. System detects repository and loads history
9. History browser shows the checkpoint created in step 3

**Test: Crash Recovery**
1. User works on layout with auto-checkpoint enabled
2. System crashes (simulated) without graceful save
3. User restarts KLayout and opens same file
4. System detects uncommitted checkpoint data in recovery area
5. Dialog offers to recover lost work
6. User accepts recovery
7. Layout state restored to last auto-checkpoint

### 6.2 Version Control Operations

**Test: Branch Experimentation**
1. User creates checkpoint "Baseline" on main branch
2. User creates new branch "experiment/wide-metal"
3. User modifies metal width on critical paths
4. User creates checkpoint "Wide metal applied"
5. User switches back to main branch
6. Visual inspection confirms wide metal changes absent
7. User switches to experiment/wide-metal branch
8. Visual inspection confirms wide metal changes present
9. User merges experiment/wide-metal into main
10. Main branch now contains wide metal changes

**Test: Visual Diff**
1. User has two checkpoints: "Before Routing" and "After Routing"
2. User selects both in history browser and chooses "Compare"
3. System displays split view or XOR overlay
4. New routing appears highlighted (green/addition)
5. Deleted guides appear highlighted (red/removal)
6. Statistics panel shows polygon count delta and bounding box change

### 6.3 Data Integrity

**Test: Round-trip Fidelity**
1. Load complex test GDSII containing all primitive types
2. Create checkpoint (serialize to text)
3. Generate Python reconstruction code from checkpoint
4. Execute Python code in fresh KLayout instance
5. Export both original and reconstructed layouts to GDSII
6. Binary comparison shows identical files (or XOR comparison shows zero difference)

**Test: Determinism**
1. Load layout and create checkpoint
2. Note checksum of text representation
3. Reload layout from GDSII
4. Create new checkpoint
5. Verify checksum identical to step 2
6. Repeat 10 times—all checksums match

### 6.4 MCP Agent Integration

**Test: Agent Optimization with History**
1. Agent initializes VC for current layout
2. Agent creates checkpoint "Iteration 0"
3. Agent modifies layout 5 times, creating checkpoint after each
4. Agent queries history, verifies 6 checkpoints exist
5. Agent diffs checkpoint 5 vs checkpoint 2
6. Agent decides checkpoint 2 was optimal
7. Agent checks out checkpoint 2
8. UI reflects checkout—layout displays state from iteration 2

**Test: Agent Code Generation**
1. Agent requests Python code generation for current checkpoint
2. System returns executable Python script
3. Agent (or test harness) executes script in separate KLayout process
4. Generated layout matches original in geometry and hierarchy

---

## 7. Development Phases

### Phase 1: Foundation (Core Data)
- Implement layout serialization ensuring deterministic output
- Implement deserialization (text → KLayout memory)
- Implement round-trip verification tests
- Deliverable: Lossless GDSII ↔ Text converter with 100% primitive coverage

### Phase 2: Local Versioning (Memory & Disk)
- Implement memory-mode checkpoint stack
- Implement sidecar repository creation on save
- Implement basic Git integration (init, commit, log)
- Deliverable: Checkpoint/History/Checkout functional for single linear timeline

### Phase 3: Visualization & Branching
- History browser UI with thumbnails
- Visual diff rendering (XOR or side-by-side)
- Branch creation and switching
- Merge with conflict detection
- Deliverable: Full Git-like workflow within KLayout GUI

### Phase 4: Agent Interface
- MCP server integration
- Tool implementations for all VC operations
- Agent workflow examples (optimization, regression)
- Deliverable: AI agents can programmatically control layout history

### Phase 5: Polish & Testing
- E2E test suite covering all user stories
- Performance optimization
- Crash recovery implementation
- Documentation and examples
- Deliverable: Production-ready plugin with test coverage

---

## 8. Risk Considerations

| Risk | Mitigation |
|------|------------|
| **Serialization errors** causing geometry loss | Extensive round-trip testing with diverse real-world layouts; checksum verification |
| **Performance degradation** with large layouts | Lazy loading of history; background serialization; configurable auto-checkpoint intervals |
| **Repository corruption** | Atomic file operations; backup snapshots; repair/recovery modes |
| **User confusion** with detached HEAD states | Clear UI indicators; simplified branching model; warnings before destructive operations |
| **MCP security** | Local-only MCP server; no remote execution; sandboxed layout operations |

---

## 9. Open Questions

1. **Storage format**: JSON vs YAML vs custom DSL? (Decision: JSON for tooling ecosystem)
2. **Checkpoint granularity**: Full snapshot vs delta? (Decision: Full snapshot for reliability, compress via Git)
3. **Branch visualization**: Linear list vs full DAG? (Decision: Simplified tree for usability, full DAG available via external Git client)
4. **Merge semantics**: Auto-merge non-overlapping geometry? (Decision: Detect conflicts, manual resolution via UI)