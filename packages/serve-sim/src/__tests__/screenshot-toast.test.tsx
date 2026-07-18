import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ScreenshotToast } from "../client/components/screenshot-toast";
import {
  filenameFromContentDisposition,
  type ScreenshotToast as ScreenshotToastState,
} from "../client/hooks/use-screenshot-toast";

const noop = () => {};

function render(toast: ScreenshotToastState): string {
  return renderToStaticMarkup(
    <ScreenshotToast
      toast={toast}
      onDownload={noop}
      onPause={noop}
      onResume={noop}
    />,
  );
}

describe("ScreenshotToast browser download", () => {
  test("saved screenshot offers a browser download instead of a host Finder action", () => {
    const html = render({
      id: "1",
      status: "saved",
      phase: "in",
      downloadUrl: "blob:shot",
      filename: "shot.png",
      thumb: "blob:shot",
    });
    expect(html).toContain('aria-label="Download screenshot"');
    expect(html).toContain("Screenshot Downloaded");
    expect(html).toContain("Download again");
    expect(html).not.toContain("Finder");
  });

  test("saving screenshot cannot be downloaded before the response arrives", () => {
    const html = render({ id: "1", status: "saving", phase: "in" });
    expect(html).toContain("Saving Screenshot");
    expect(html).toContain("disabled");
  });

  test("extracts safe browser filenames from content-disposition", () => {
    expect(filenameFromContentDisposition('attachment; filename="serve-sim-shot.png"'))
      .toBe("serve-sim-shot.png");
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''capture%20%C3%A9.png"))
      .toBe("capture é.png");
    expect(filenameFromContentDisposition('attachment; filename="../../escape.png"'))
      .toBe("escape.png");
  });
});
