import { Background } from './background.js';

class VirtualCanvasStream {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1920; // Set desired width
    this.canvas.height = 1080; // Set desired height
    this.ctx = this.canvas.getContext("2d");
    this.outputStream = this.canvas.captureStream(5);
    this.textLine1 = '';
    this.textLine2 = '';
    this.padding = 20; // Padding for the text
    this.text = 'LinTO Bot';
    this.background = new Background(this.canvas); // Initialize the background animation
    this.update();
    window.fakeWebcam = this;
  }

  drawText() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.font = "30px Arial";
    this.ctx.fillStyle = "white";
    this.ctx.textAlign = "center";
    if (this.textLine1) {
      this.ctx.fillText(this.textLine1, this.canvas.width / 2, this.canvas.height / 2 - 20);
    }
    if (this.textLine2) {
      this.ctx.fillText(this.textLine2, this.canvas.width / 2, this.canvas.height / 2 + 20);
    }
  }

  update() {
    this.background.update(); // Update the background animation
    this.drawText(); // Draw the text
    requestAnimationFrame(() => this.update());
  }

  setText(newText, final = false) {
    this.textLine1 = newText;
  
}




}

export { VirtualCanvasStream };
