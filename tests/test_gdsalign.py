#!/usr/bin/env python
"""Tests for nanodevice:gdsalign pipeline scripts.

All tests use local fixtures in tests_resources/ml08/.
"""
import json
import math
import os
import sys
import tempfile

import numpy as np
import pytest

from conftest import (
    FULL_STACK_RAW, GDSALIGN_DIR, PIXEL_SIZE, TEMPLATE_GDS, run_gdsalign_script,
)


def _import_align_gds():
    """Import align_gds.py as a module — its functions are module-level and
    main() is guarded by __main__, so importing has no side effects."""
    import importlib
    if GDSALIGN_DIR not in sys.path:
        sys.path.insert(0, GDSALIGN_DIR)
    return importlib.import_module("align_gds")


def _import_commit_gds():
    import importlib
    if GDSALIGN_DIR not in sys.path:
        sys.path.insert(0, GDSALIGN_DIR)
    return importlib.import_module("commit_gds")


class TestExtractMarkers:
    """Tests for extract_markers.py — GDS L5/0 marker pair extraction."""

    def test_extracts_4_pairs(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc, out, err = run_gdsalign_script("extract_markers.py", [
                "--gds", TEMPLATE_GDS, "--output-dir", tmp,
            ])
            assert rc == 0, f"Script failed: {err}"
            with open(os.path.join(tmp, "gds_markers.json")) as f:
                data = json.load(f)
            assert len(data["pairs"]) == 4

    def test_pair_centers_match_known_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_gdsalign_script("extract_markers.py", [
                "--gds", TEMPLATE_GDS, "--output-dir", tmp,
            ])
            with open(os.path.join(tmp, "gds_markers.json")) as f:
                data = json.load(f)
            centers = {p["label"]: p["center_um"] for p in data["pairs"]}
            assert abs(centers["NE"][0] - 812.5) < 1.0
            assert abs(centers["NE"][1] - 812.5) < 1.0
            assert abs(centers["SW"][0] - 737.5) < 1.0
            assert abs(centers["SW"][1] - 737.5) < 1.0
            assert abs(centers["NW"][0] - 737.5) < 1.0
            assert abs(centers["NW"][1] - 812.5) < 1.0
            assert abs(centers["SE"][0] - 812.5) < 1.0
            assert abs(centers["SE"][1] - 737.5) < 1.0

    def test_each_pair_has_2_markers_with_bbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_gdsalign_script("extract_markers.py", [
                "--gds", TEMPLATE_GDS, "--output-dir", tmp,
            ])
            with open(os.path.join(tmp, "gds_markers.json")) as f:
                data = json.load(f)
            for pair in data["pairs"]:
                assert len(pair["markers"]) == 2
                for m in pair["markers"]:
                    assert "bbox" in m
                    assert len(m["bbox"]) == 2


class TestDetectMarkers:
    """Tests for detect_markers.py — template matching in microscope image."""

    def _run_extract_first(self, tmp):
        rc, _, err = run_gdsalign_script("extract_markers.py", [
            "--gds", TEMPLATE_GDS, "--output-dir", tmp,
        ])
        assert rc == 0, f"extract_markers failed: {err}"
        return os.path.join(tmp, "gds_markers.json")

    def test_detects_markers_in_ml08(self):
        with tempfile.TemporaryDirectory() as tmp:
            gds_markers = self._run_extract_first(tmp)
            rc, out, err = run_gdsalign_script("detect_markers.py", [
                "--image", FULL_STACK_RAW,
                "--pixel-size", PIXEL_SIZE,
                "--gds-markers", gds_markers,
                "--output-dir", tmp,
            ])
            assert rc == 0, f"Script failed: {err}"
            with open(os.path.join(tmp, "image_markers.json")) as f:
                data = json.load(f)
            assert data["status"] == "complete"
            assert len(data["detections"]) >= 3

    def test_detections_have_required_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            gds_markers = self._run_extract_first(tmp)
            run_gdsalign_script("detect_markers.py", [
                "--image", FULL_STACK_RAW,
                "--pixel-size", PIXEL_SIZE,
                "--gds-markers", gds_markers,
                "--output-dir", tmp,
            ])
            with open(os.path.join(tmp, "image_markers.json")) as f:
                data = json.load(f)
            for det in data["detections"]:
                assert "center_px" in det
                assert "center_um" in det
                assert "score" in det
                assert "rotation_deg" in det

    def test_produces_diagnostic_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            gds_markers = self._run_extract_first(tmp)
            run_gdsalign_script("detect_markers.py", [
                "--image", FULL_STACK_RAW,
                "--pixel-size", PIXEL_SIZE,
                "--gds-markers", gds_markers,
                "--output-dir", tmp,
            ])
            assert os.path.exists(os.path.join(tmp, "01_template.png"))
            assert os.path.exists(os.path.join(tmp, "03_detections.png"))


class TestAlignGds:
    """Tests for align_gds.py — marker correspondence + similarity transform."""

    def _run_pipeline_to_detect(self, tmp):
        run_gdsalign_script("extract_markers.py", [
            "--gds", TEMPLATE_GDS, "--output-dir", tmp,
        ])
        run_gdsalign_script("detect_markers.py", [
            "--image", FULL_STACK_RAW,
            "--pixel-size", PIXEL_SIZE,
            "--gds-markers", os.path.join(tmp, "gds_markers.json"),
            "--output-dir", tmp,
        ])
        return (
            os.path.join(tmp, "gds_markers.json"),
            os.path.join(tmp, "image_markers.json"),
        )

    def test_computes_transform(self):
        with tempfile.TemporaryDirectory() as tmp:
            gds_m, img_m = self._run_pipeline_to_detect(tmp)
            rc, out, err = run_gdsalign_script("align_gds.py", [
                "--gds-markers", gds_m,
                "--image-markers", img_m,
                "--output-dir", tmp,
            ])
            assert rc == 0, f"Script failed: {err}"
            with open(os.path.join(tmp, "gds_alignment_report.json")) as f:
                report = json.load(f)
            assert report["status"] == "complete"
            assert report["quality"]["inliers"] >= 3

    def test_warp_matrix_is_2x3(self):
        with tempfile.TemporaryDirectory() as tmp:
            gds_m, img_m = self._run_pipeline_to_detect(tmp)
            run_gdsalign_script("align_gds.py", [
                "--gds-markers", gds_m,
                "--image-markers", img_m,
                "--output-dir", tmp,
            ])
            M = np.load(os.path.join(tmp, "gds_warp.npy"))
            assert M.shape == (2, 3)

    def test_scale_near_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            gds_m, img_m = self._run_pipeline_to_detect(tmp)
            run_gdsalign_script("align_gds.py", [
                "--gds-markers", gds_m,
                "--image-markers", img_m,
                "--output-dir", tmp,
            ])
            with open(os.path.join(tmp, "gds_alignment_report.json")) as f:
                report = json.load(f)
            scale = report["transform"]["scale"]
            assert 0.8 < scale < 1.5, f"Scale {scale} outside range"

    def test_residual_below_threshold(self):
        with tempfile.TemporaryDirectory() as tmp:
            gds_m, img_m = self._run_pipeline_to_detect(tmp)
            run_gdsalign_script("align_gds.py", [
                "--gds-markers", gds_m,
                "--image-markers", img_m,
                "--output-dir", tmp,
            ])
            with open(os.path.join(tmp, "gds_alignment_report.json")) as f:
                report = json.load(f)
            assert report["quality"]["mean_residual_um"] < 2.0


class TestCommitGds:
    """Tests for commit_gds.py — warp image + contours into GDS coords."""

    def _run_full_pipeline(self, tmp):
        run_gdsalign_script("extract_markers.py", [
            "--gds", TEMPLATE_GDS, "--output-dir", tmp,
        ])
        run_gdsalign_script("detect_markers.py", [
            "--image", FULL_STACK_RAW, "--pixel-size", PIXEL_SIZE,
            "--gds-markers", os.path.join(tmp, "gds_markers.json"),
            "--output-dir", tmp,
        ])
        run_gdsalign_script("align_gds.py", [
            "--gds-markers", os.path.join(tmp, "gds_markers.json"),
            "--image-markers", os.path.join(tmp, "image_markers.json"),
            "--output-dir", tmp,
        ])
        return tmp

    def _make_synthetic_traces(self, tmp):
        """Create a minimal traces.json with a square contour."""
        traces = {
            "image": "full_stack_raw.jpg",
            "pixel_size_um": 0.087,
            "image_size_px": [4096, 3000],
            "image_size_um": [356.352, 261.0],
            "stack": ["top_hBN", "graphene", "bottom_hBN", "graphite"],
            "layer_map": {
                "top_hBN": "10/0",
                "graphene": "11/0",
                "bottom_hBN": "12/0",
                "graphite": "13/0",
            },
            "materials": {
                "graphite": [{
                    "id": 0,
                    "contour_px": [[100, 100], [200, 100], [200, 200], [100, 200]],
                    "contour_um": [[8.7, 8.7], [17.4, 8.7], [17.4, 17.4], [8.7, 17.4]],
                    "area_um2": 75.69,
                    "num_points": 4,
                }],
                "graphene": [],
                "bottom_hBN": [],
                "top_hBN": [],
            },
        }
        path = os.path.join(tmp, "traces.json")
        with open(path, "w") as f:
            json.dump(traces, f)
        return path

    def test_warp_only_produces_warped_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_full_pipeline(tmp)
            traces_path = self._make_synthetic_traces(tmp)
            rc, out, err = run_gdsalign_script("commit_gds.py", [
                "--warp", os.path.join(tmp, "gds_warp.npy"),
                "--traces", traces_path,
                "--image", FULL_STACK_RAW,
                "--pixel-size", PIXEL_SIZE,
                "--gds", TEMPLATE_GDS,
                "--output-dir", tmp,
                "--warp-only",
            ])
            assert rc == 0, f"Script failed: {err}"
            assert os.path.exists(os.path.join(tmp, "full_stack_gds.png"))
            assert os.path.exists(os.path.join(tmp, "traces_gds.json"))

    def test_transformed_contours_in_gds_coords(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_full_pipeline(tmp)
            traces_path = self._make_synthetic_traces(tmp)
            run_gdsalign_script("commit_gds.py", [
                "--warp", os.path.join(tmp, "gds_warp.npy"),
                "--traces", traces_path,
                "--image", FULL_STACK_RAW,
                "--pixel-size", PIXEL_SIZE,
                "--gds", TEMPLATE_GDS,
                "--output-dir", tmp,
                "--warp-only",
            ])
            with open(os.path.join(tmp, "traces_gds.json")) as f:
                data = json.load(f)
            for mat_name, mat_data in data["materials"].items():
                for trace in mat_data:
                    for pt in trace["contour_gds"]:
                        assert -2000 < pt[0] < 4000, \
                            f"{mat_name} x={pt[0]} out of range"
                        assert -2000 < pt[1] < 3000, \
                            f"{mat_name} y={pt[1]} out of range"

    def _commit_args(self, tmp, traces_path, *extra):
        return [
            "--warp", os.path.join(tmp, "gds_warp.npy"),
            "--traces", traces_path,
            "--image", FULL_STACK_RAW,
            "--pixel-size", PIXEL_SIZE,
            "--gds", TEMPLATE_GDS,
            "--output-dir", tmp,
            "--warp-only",
        ] + list(extra)

    def test_registration_gate_blocks_missing_align_report(self):
        """A warp with no gds_alignment_report.json next to it (the skipped /
        hand-rolled failure mode) must be rejected, not silently committed."""
        with tempfile.TemporaryDirectory() as tmp:
            self._run_full_pipeline(tmp)
            traces_path = self._make_synthetic_traces(tmp)
            os.remove(os.path.join(tmp, "gds_alignment_report.json"))
            rc, out, err = run_gdsalign_script(
                "commit_gds.py", self._commit_args(tmp, traces_path))
            assert rc != 0, "commit should fail without an alignment report"
            assert "registration" in (out + err).lower()
            assert "align_gds" in (out + err)

    def test_registration_gate_blocks_mismatched_handrolled_warp(self):
        """A hand-rolled warp that does not match the alignment report (or lands
        flakes off the marker field) must be rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            self._run_full_pipeline(tmp)
            traces_path = self._make_synthetic_traces(tmp)
            # Overwrite the validated warp with a hand-rolled centered y-flip
            # (the exact AH06/HM08 antipattern) that does NOT match the report.
            np.save(os.path.join(tmp, "gds_warp.npy"),
                    np.array([[1.0, 0.0, 600.0], [0.0, -1.0, 600.0]]))
            rc, out, err = run_gdsalign_script(
                "commit_gds.py", self._commit_args(tmp, traces_path))
            assert rc != 0, "commit should reject a hand-rolled mismatched warp"

    def test_skip_registration_check_bypasses_gate(self):
        """The explicit escape hatch lets an intentional hand-built transform
        through (so the gate never hard-blocks a deliberate workflow)."""
        with tempfile.TemporaryDirectory() as tmp:
            self._run_full_pipeline(tmp)
            traces_path = self._make_synthetic_traces(tmp)
            os.remove(os.path.join(tmp, "gds_alignment_report.json"))
            rc, out, err = run_gdsalign_script(
                "commit_gds.py",
                self._commit_args(tmp, traces_path, "--skip-registration-check"))
            assert rc == 0, f"--skip-registration-check should bypass: {err}"


class TestRotationalDisambiguation:
    """Regression for the HM11 gdsalign bug: a 4-fold-symmetric square L5 grid
    leaves the rotation 4-way ambiguous. The disambiguation must pick the branch
    closest to 0 deg, but its inlier/acceptance windows (max_res*3, mean_res*2)
    collapsed to ~0 when the wrong base branch fit perfectly, rejecting every
    companion and keeping the wrong 90-deg branch. The windows are floored to
    1.0 um so the correct branch is recovered."""

    def _square_scenario(self):
        ag = _import_align_gds()
        C = np.array([775.0, 775.0])
        # 4 corners of a 75 um square about the grid center
        gds_pts = np.array([[812.5, 812.5], [737.5, 812.5],
                            [737.5, 737.5], [812.5, 737.5]])
        img_pts = gds_pts.copy()
        # TRUE branch: reflection about y=Cy, rotation 0 deg
        M_true = np.array([[1.0, 0.0, 0.0], [0.0, -1.0, 2 * C[1]]])
        # WRONG base branch: M_true rotated +90 deg about C (also fits perfectly)
        R90 = np.array([[0.0, -1.0], [1.0, 0.0]])
        M_base = np.zeros((2, 3))
        M_base[:2, :2] = R90 @ M_true[:2, :2]
        M_base[:2, 2] = R90 @ (M_true[:2, 2] - C) + C
        theta_base = math.atan2(M_base[1, 0], M_base[0, 0])
        n_in, _avg, corr = ag._score_transform(
            M_base, img_pts, gds_pts, inlier_thresh=1.0)
        src = np.array([img_pts[ii] for ii, gi, _ in corr])
        dst = np.array([gds_pts[gi] for ii, gi, _ in corr])
        res = np.sqrt(((ag.apply_transform(M_base, src) - dst) ** 2).sum(axis=1))
        return ag, dict(M_base=M_base, theta_base=theta_base, mean_res=float(res.mean()),
                        max_res=float(res.max()), corr=corr, src=src, dst=dst,
                        res=res, n_in=n_in, img_pts=img_pts, gds_pts=gds_pts, C=C)

    def test_base_branch_is_the_wrong_90deg_branch(self):
        """Sanity: the synthetic base really is the wrong ~90 deg branch with
        a perfect (residual ~0) fit — the condition that broke HM11."""
        _ag, s = self._square_scenario()
        assert abs(math.degrees(s["theta_base"])) == pytest.approx(90.0, abs=1e-6)
        assert s["max_res"] == pytest.approx(0.0, abs=1e-6)
        assert s["n_in"] == 4

    def test_disambiguation_recovers_zero_rotation_branch(self):
        """With the floored windows, the rotation-0 companion is recovered."""
        ag, s = self._square_scenario()
        chosen = ag.disambiguate_rotation(
            s["M_base"], s["theta_base"], s["mean_res"], s["max_res"],
            s["corr"], s["src"], s["dst"], s["res"], s["n_in"],
            s["img_pts"], s["gds_pts"], s["C"], True)
        chosen_rot = math.degrees(chosen[1])
        assert abs(chosen_rot) < 5.0, (
            f"disambiguation kept the wrong branch (rot={chosen_rot:.1f} deg); "
            f"expected ~0 deg")


class TestRegistrationFrameCheck:
    """The commit_gds registration frame check (#4) must key on distance from
    the marker grid CENTER (scaled by field size), not the huge outer bbox.
    Regression for the verification finding that bbox+/-25% let HM08/AH06/QH06
    offsets (~520-1144 um in a 1550 um field) all escape."""

    def _setup(self, tmp, flake_center_xy):
        cg = _import_commit_gds()
        # A valid reflected transform: y-flip about y=775, rotation 0, scale 1.
        M = np.array([[1.0, 0.0, 0.0], [0.0, -1.0, 1550.0]])
        np.save(os.path.join(tmp, "gds_warp.npy"), M)
        report = {
            "status": "complete",
            "transform": {"rotation_deg": 0.0, "scale": 1.0,
                          "translation_um": [0.0, 1550.0], "reflected": True},
            "quality": {"inliers": 4, "mean_residual_um": 0.1, "max_residual_um": 0.2},
        }
        with open(os.path.join(tmp, "gds_alignment_report.json"), "w") as f:
            json.dump(report, f)
        with open(os.path.join(tmp, "gds_markers.json"), "w") as f:
            json.dump({"grid_center_um": [775.0, 775.0],
                       "grid_bbox_um": [[0.0, 0.0], [1550.0, 1550.0]]}, f)
        cx, cy = flake_center_xy
        traces_gds = {"materials": {"graphene": [{"contour_gds": [
            [cx - 30, cy - 30], [cx + 30, cy - 30],
            [cx + 30, cy + 30], [cx - 30, cy + 30]]}]}}
        return cg, M, os.path.join(tmp, "gds_warp.npy"), traces_gds

    def test_centered_device_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cg, M, warp, traces = self._setup(tmp, (775.0, 775.0))
            ok, msg = cg.validate_registration(M, warp, None, None, traces)
            assert ok, f"a centered device must pass: {msg}"

    def test_off_frame_device_at_origin_is_caught(self):
        """A device at the GDS origin (the QH06 ~1144 um-from-center failure)
        must now be rejected — the old bbox check let it through."""
        with tempfile.TemporaryDirectory() as tmp:
            cg, M, warp, traces = self._setup(tmp, (0.0, 0.0))
            ok, msg = cg.validate_registration(M, warp, None, None, traces)
            assert not ok, "flakes at origin must be flagged off-frame"
            assert "WRONG frame" in msg or "wrong frame" in msg.lower()

    def test_off_frame_device_500um_offset_is_caught(self):
        """The HM08/AH06 ~520 um displacement (centroid ~(1148,392)) must be
        caught — it was ~48% of the field half-span, inside the old bbox."""
        with tempfile.TemporaryDirectory() as tmp:
            cg, M, warp, traces = self._setup(tmp, (1148.0, 392.0))
            ok, msg = cg.validate_registration(M, warp, None, None, traces)
            assert not ok, "a ~520 um off-center device must be flagged off-frame"
