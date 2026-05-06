"""Unit tests for issue #31: footprint.py --warp PATH reuses precomputed SIFT warp.

Asserts:
- Passing --warp <path-to-known-warp.npy> skips the internal SIFT pass.
- The matrix loaded from disk matches what footprint.py uses for the diff stage.
- Auto-lookup falls back to <output_dir>/warp_sift_bottom.npy when --warp omitted.
- Internal SIFT is only invoked when neither --warp nor a default path resolves.

Run:
    conda run -n instrMCPdev python -m pytest tests/test_footprint_warp.py -v
"""

import importlib.util
import os
import sys
import tempfile
import unittest

import cv2
import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, ".."))
FOOTPRINT_PATH = os.path.join(
    REPO_ROOT, "skills", "nanodevice_flakedetect_align", "scripts", "footprint.py"
)


def _import_footprint():
    """Import footprint.py as a module without running argparse."""
    # core.py lives in the flakedetect skill; footprint.py adds it to sys.path
    spec = importlib.util.spec_from_file_location("footprint_mod", FOOTPRINT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestResolveWarpPath(unittest.TestCase):
    """resolve_warp_path() priority: --warp > output_dir > source_parent/align."""

    def setUp(self):
        self.mod = _import_footprint()
        self.tmp = tempfile.mkdtemp(prefix="footprint_warp_")
        # Layout:
        #   tmp/runs/align/warp_sift_bottom.npy   (source_parent/align candidate)
        #   tmp/runs/source/top_part.png          (source image)
        #   tmp/output/warp_sift_bottom.npy       (output_dir candidate)
        os.makedirs(os.path.join(self.tmp, "runs", "align"))
        os.makedirs(os.path.join(self.tmp, "runs", "source"))
        os.makedirs(os.path.join(self.tmp, "output"))
        self.source_path = os.path.join(self.tmp, "runs", "source", "top_part.png")
        cv2.imwrite(self.source_path, np.zeros((10, 10, 3), dtype=np.uint8))

    def _write_warp(self, path, value):
        m = np.array([[value, 0.0, 0.0], [0.0, value, 0.0]], dtype=np.float64)
        np.save(path, m)
        return m

    def test_explicit_warp_takes_priority(self):
        explicit = os.path.join(self.tmp, "explicit_warp.npy")
        self._write_warp(explicit, 1.0)
        # Decoy at output dir + source_parent/align should NOT be selected
        self._write_warp(os.path.join(self.tmp, "output", "warp_sift_bottom.npy"), 2.0)
        self._write_warp(os.path.join(self.tmp, "runs", "align", "warp_sift_bottom.npy"), 3.0)
        path, src = self.mod.resolve_warp_path(
            explicit_path=explicit,
            output_dir=os.path.join(self.tmp, "output"),
            source_path=self.source_path,
        )
        self.assertEqual(path, explicit)
        self.assertEqual(src, "--warp")

    def test_explicit_missing_returns_none(self):
        path, src = self.mod.resolve_warp_path(
            explicit_path="/no/such/warp.npy",
            output_dir=os.path.join(self.tmp, "output"),
            source_path=self.source_path,
        )
        self.assertIsNone(path)
        self.assertIsNone(src)

    def test_output_dir_lookup(self):
        out_warp = os.path.join(self.tmp, "output", "warp_sift_bottom.npy")
        self._write_warp(out_warp, 1.0)
        # Source-parent decoy should be skipped (output_dir wins)
        self._write_warp(os.path.join(self.tmp, "runs", "align", "warp_sift_bottom.npy"), 9.0)
        path, src = self.mod.resolve_warp_path(
            explicit_path=None,
            output_dir=os.path.join(self.tmp, "output"),
            source_path=self.source_path,
        )
        self.assertEqual(path, out_warp)
        self.assertEqual(src, "output_dir")

    def test_source_parent_align_lookup(self):
        align_warp = os.path.join(self.tmp, "runs", "align", "warp_sift_bottom.npy")
        self._write_warp(align_warp, 1.0)
        path, src = self.mod.resolve_warp_path(
            explicit_path=None,
            output_dir=os.path.join(self.tmp, "output"),
            source_path=self.source_path,
        )
        self.assertEqual(path, align_warp)
        self.assertEqual(src, "source_parent/align")

    def test_no_candidate_returns_none(self):
        path, src = self.mod.resolve_warp_path(
            explicit_path=None,
            output_dir=os.path.join(self.tmp, "output"),
            source_path=self.source_path,
        )
        self.assertIsNone(path)
        self.assertIsNone(src)


class TestLoadWarpMatrix(unittest.TestCase):
    """load_warp_matrix() returns the same matrix that np.save wrote."""

    def setUp(self):
        self.mod = _import_footprint()
        self.tmp = tempfile.mkdtemp(prefix="footprint_loadwarp_")

    def test_roundtrip(self):
        path = os.path.join(self.tmp, "w.npy")
        original = np.array(
            [[1.0023, -0.0114, 12.5], [0.0114, 1.0023, -7.25]],
            dtype=np.float64,
        )
        np.save(path, original)
        loaded = self.mod.load_warp_matrix(path)
        np.testing.assert_array_equal(loaded, original)

    def test_rejects_wrong_shape(self):
        path = os.path.join(self.tmp, "bad.npy")
        np.save(path, np.eye(3))
        with self.assertRaises(ValueError):
            self.mod.load_warp_matrix(path)


class TestFootprintSkipsSiftWhenWarpProvided(unittest.TestCase):
    """End-to-end: footprint.py --warp PATH must NOT call sift_align internally.

    We monkeypatch sift_align to a sentinel that raises if called, then run
    main() far enough to hit the SIFT branch. The internal pipeline failing
    later (no real flake in our synthetic image) is fine — what matters is
    that sift_align was never invoked.
    """

    def setUp(self):
        self.mod = _import_footprint()
        self.tmp = tempfile.mkdtemp(prefix="footprint_e2e_")
        # Synthesise tiny BGR images that cv2.imread can read back
        self.src = os.path.join(self.tmp, "top_part.png")
        self.tgt = os.path.join(self.tmp, "full_stack.png")
        self.bot = os.path.join(self.tmp, "bottom_part.png")
        cv2.imwrite(self.src, np.full((64, 64, 3), 200, dtype=np.uint8))
        cv2.imwrite(self.tgt, np.full((64, 64, 3), 100, dtype=np.uint8))
        cv2.imwrite(self.bot, np.full((64, 64, 3), 100, dtype=np.uint8))

        self.outdir = os.path.join(self.tmp, "out")
        os.makedirs(self.outdir)

        # Known warp matrix (identity)
        self.warp_path = os.path.join(self.tmp, "warp_sift_bottom.npy")
        self.expected = np.array(
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64
        )
        np.save(self.warp_path, self.expected)

        # Pre-computed source contour/mask so segment_source_flake() is
        # bypassed — keeps the test focused on the SIFT-skip behaviour.
        sm = np.zeros((64, 64), dtype=np.uint8)
        cv2.rectangle(sm, (16, 16), (48, 48), 255, -1)
        self.src_mask_path = os.path.join(self.tmp, "src_mask.png")
        cv2.imwrite(self.src_mask_path, sm)
        cnt = np.array(
            [[[16, 16]], [[48, 16]], [[48, 48]], [[16, 48]]], dtype=np.int32
        )
        self.src_contour_path = os.path.join(self.tmp, "src_contour.npy")
        np.save(self.src_contour_path, cnt)

    def test_warp_arg_skips_sift(self):
        called = {"sift": False, "warp_matrix_seen": None}

        def fake_sift(*a, **kw):
            called["sift"] = True
            raise AssertionError("sift_align must NOT be invoked when --warp is provided")

        # Capture the warp_matrix that the diff stage receives
        real_diff = self.mod.compute_diff_image

        def spy_diff(target_bgr, bottom_bgr, warp_matrix):
            called["warp_matrix_seen"] = np.array(warp_matrix, copy=True)
            return real_diff(target_bgr, bottom_bgr, warp_matrix)

        self.mod.sift_align = fake_sift
        self.mod.compute_diff_image = spy_diff

        argv = [
            "footprint.py",
            "--source", self.src,
            "--target", self.tgt,
            "--bottom", self.bot,
            "--source-contour", self.src_contour_path,
            "--source-mask", self.src_mask_path,
            "--pixel-size", "0.1",
            "--output-dir", self.outdir,
            "--warp", self.warp_path,
        ]
        old_argv = sys.argv
        sys.argv = argv
        try:
            try:
                self.mod.main()
            except SystemExit:
                # Pipeline will exit somewhere downstream of SIFT on synthetic
                # input; that's fine for this test.
                pass
        finally:
            sys.argv = old_argv

        self.assertFalse(called["sift"], "sift_align should not have been called")
        self.assertIsNotNone(
            called["warp_matrix_seen"],
            "compute_diff_image was never called — pipeline bailed before "
            "reaching the warp consumer; check resolve_warp_path wiring."
        )
        np.testing.assert_array_equal(called["warp_matrix_seen"], self.expected)


if __name__ == "__main__":
    unittest.main()
