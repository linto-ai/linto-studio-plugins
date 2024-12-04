import { Background } from './background.js';
import { SubtitleScroller } from './splitter.js';

class VirtualCanvasStream {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1920; // Set desired width
    this.canvas.height = 1080; // Set desired height
    this.ctx = this.canvas.getContext("2d");
    this.outputStream = this.canvas.captureStream(5);
    this.drawer = new SubtitleScroller(this.canvas)
    window.fakeWebcam = this;
    this.setText("Transcription ready", true);
  }

  setText(newText, final = false) {
    if (final) {
      this.drawer.newFinal(newText);
    }
    else {
      this.drawer.newPartial(newText);
    }
  }

}

export { VirtualCanvasStream };
