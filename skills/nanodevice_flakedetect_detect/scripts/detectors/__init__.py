"""C3 ensemble detectors — B1 / B2 / B3 wrapped as callable functions.

Each detector returns:
    {"mask": np.uint8 mask, "raw_mask": np.uint8 (pre-clean seed mask)}

Caller computes self-confidence on the *clean mask*, picks the best, then
applies post-processing (region-grow + 1.5 µm dilation).
"""
