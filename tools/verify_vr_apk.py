#!/usr/bin/env python3
"""
Assert that a built APK is actually a VR app, not a flat Android one.

This check exists because a build succeeded, installed cleanly, and launched
on a Quest as an ordinary 2D panel — the export had quietly produced a
non-VR APK and nothing in the pipeline noticed. "It compiled" says nothing
about whether the headset will treat it as immersive, so the two things that
decide that are checked directly against the binary:

  1. **libopenxr_loader.so** must be in the APK. Without it OpenXR cannot
     initialise at runtime, the app falls back to flat rendering, and the
     only symptom is a 2D window.

  2. **The VR intent categories** must be in the manifest. Quest decides
     whether to launch an app immersively from these; an APK can contain a
     perfectly good OpenXR loader and still open as a panel without them.

The manifest is binary AXML, so rather than parse it properly the string
pool is decoded loosely — enough to tell whether the category names are
present, which is all this needs to know.
"""
import re
import sys
import zipfile

REQUIRED_CATEGORIES = (
    "com.oculus.intent.category.VR",
    "org.khronos.openxr.intent.category.IMMERSIVE_HMD",
)


def main() -> int:
    apk_path = sys.argv[1]
    failures = []

    with zipfile.ZipFile(apk_path) as apk:
        names = apk.namelist()

        loaders = [n for n in names if "libopenxr_loader.so" in n]
        if loaders:
            print(f"ok    OpenXR loader present: {loaders[0]}")
        else:
            failures.append("libopenxr_loader.so is missing — OpenXR cannot "
                            "initialise, so the app will launch flat")
            print("      native libs found:")
            for n in names:
                if n.endswith(".so"):
                    print(f"        {n}")

        manifest = apk.read("AndroidManifest.xml")

    # AXML string pool is UTF-16LE; a loose decode is enough to spot names.
    text = manifest.decode("utf-16-le", errors="ignore")
    strings = set(re.findall(r"[ -~]{6,}", text))
    joined = "\n".join(strings)

    for category in REQUIRED_CATEGORIES:
        if category in joined:
            print(f"ok    manifest declares {category}")
        else:
            failures.append(f"manifest is missing {category} — the headset "
                            f"will open this as a 2D panel")

    if failures:
        print("\nNOT A VR APK:")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("\nVR APK VERIFIED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
