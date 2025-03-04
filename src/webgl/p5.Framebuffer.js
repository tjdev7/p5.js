/**
 * @module Rendering
 * @requires constants
 */

import p5 from '../core/main';
import * as constants from '../core/constants';
import { checkWebGLCapabilities } from './p5.Texture';

class FramebufferCamera extends p5.Camera {
  /**
   * A <a href="#/p5.Camera">p5.Camera</a> attached to a
   * <a href="#/p5.Framebuffer">p5.Framebuffer</a>.
   *
   * @class p5.FramebufferCamera
   * @constructor
   * @param {p5.Framebuffer} framebuffer The framebuffer this camera is
   * attached to
   * @private
   */
  constructor(framebuffer) {
    super(framebuffer.target._renderer);
    this.fbo = framebuffer;

    // WebGL textures are upside-down compared to textures that come from
    // images and graphics. Framebuffer cameras need to invert their y
    // axes when being rendered to so that the texture comes out rightway up
    // when read in shaders or image().
    this.yScale = -1;
  }

  _computeCameraDefaultSettings() {
    super._computeCameraDefaultSettings();
    this.defaultAspectRatio = this.fbo.width / this.fbo.height;
    this.defaultEyeZ =
      this.fbo.height / 2.0 / Math.tan(this.defaultCameraFOV / 2.0);
    this.defaultCameraNear = this.defaultEyeZ * 0.1;
    this.defaultCameraFar = this.defaultEyeZ * 10;
  }

  /**
   * Resets the camera to a default perspective camera sized to match
   * the p5.Framebuffer it is attached to.
   *
   * @method resize
   * @private
   */
  _resize() {
    // If we're using the default camera, update the aspect ratio
    if (this.cameraType === 'default') {
      this._computeCameraDefaultSettings();
      this._setDefaultCamera();
    } else {
      this.perspective(
        this.cameraFOV,
        this.fbo.width / this.fbo.height
      );
    }
  }
}

p5.FramebufferCamera = FramebufferCamera;

class FramebufferTexture {
  /**
   * A <a href="#/p5.Texture">p5.Texture</a> corresponding to a property of a
   * <a href="#/p5.Framebuffer">p5.Framebuffer</a>.
   *
   * @class p5.FramebufferTexture
   * @param {p5.Framebuffer} framebuffer The framebuffer represented by this
   * texture
   * @param {String} property The property of the framebuffer represented by
   * this texture, either `color` or `depth`
   * @private
   */
  constructor(framebuffer, property) {
    this.framebuffer = framebuffer;
    this.property = property;
  }

  get width() {
    return this.framebuffer.width * this.framebuffer.density;
  }

  get height() {
    return this.framebuffer.height * this.framebuffer.density;
  }

  rawTexture() {
    return this.framebuffer[this.property];
  }
}

p5.FramebufferTexture = FramebufferTexture;

class Framebuffer {
  /**
   * An object that one can draw to and then read as a texture. While similar
   * to a p5.Graphics, using a p5.Framebuffer as a texture will generally run
   * much faster, as it lives within the same WebGL context as the canvas it
   * is created on. It only works in WebGL mode.
   *
   * @class p5.Framebuffer
   * @constructor
   * @param {p5.Graphics|p5} target A p5 global instance or p5.Graphics
   * @param {Object} [settings] A settings object
   */
  constructor(target, settings = {}) {
    this.target = target;
    this.target._renderer.framebuffers.add(this);

    this.format = settings.format || constants.UNSIGNED_BYTE;
    this.channels = settings.channels || (
      target._renderer._pInst._glAttributes.alpha
        ? constants.RGBA
        : constants.RGB
    );
    this.useDepth = settings.depth === undefined ? true : settings.depth;
    this.depthFormat = settings.depthFormat || constants.FLOAT;
    this.textureFiltering = settings.textureFiltering || constants.LINEAR;
    if (settings.antialias === undefined) {
      this.antialiasSamples = target._renderer._pInst._glAttributes.antialias
        ? 2
        : 0;
    } else if (typeof settings.antialias === 'number') {
      this.antialiasSamples = settings.antialias;
    } else {
      this.antialiasSamples = settings.antialias ? 2 : 0;
    }
    this.antialias = this.antialiasSamples > 0;
    if (this.antialias && target.webglVersion !== constants.WEBGL2) {
      console.warn('Antialiasing is unsupported in a WebGL 1 context');
      this.antialias = false;
    }
    if (settings.width && settings.height) {
      this.width = settings.width;
      this.height = settings.height;
      this.autoSized = false;
    } else {
      if ((settings.width === undefined) !== (settings.height === undefined)) {
        console.warn(
          'Please supply both width and height for a framebuffer to give it a ' +
            'size. Only one was given, so the framebuffer will match the size ' +
            'of its canvas.'
        );
      }
      this.width = target.width;
      this.height = target.height;
      this.autoSized = true;
    }
    this.density = settings.density || target.pixelDensity();

    const gl = target._renderer.GL;
    this.gl = gl;

    this._checkIfFormatsAvailable();

    this.framebuffer = gl.createFramebuffer();
    if (!this.framebuffer) {
      throw new Error('Unable to create a framebuffer');
    }
    if (this.antialias) {
      this.aaFramebuffer = gl.createFramebuffer();
      if (!this.aaFramebuffer) {
        throw new Error('Unable to create a framebuffer for antialiasing');
      }
    }

    this._recreateTextures();

    const prevCam = this.target._renderer._curCamera;
    this.defaultCamera = this.createCamera();
    this.target._renderer._curCamera = prevCam;
  }

  /**
   * Resizes the framebuffer to the given width and height.
   *
   * @method resize
   * @param {Number} width
   * @param {Number} height
   *
   * @example
   * <div>
   * <code>
   * let framebuffer;
   * function setup() {
   *   createCanvas(100, 100, WEBGL);
   *   framebuffer = createFramebuffer();
   *   noStroke();
   * }
   *
   * function mouseMoved() {
   *   framebuffer.resize(
   *     max(20, mouseX),
   *     max(20, mouseY)
   *   );
   * }
   *
   * function draw() {
   *   // Draw to the framebuffer
   *   framebuffer.begin();
   *   background(255);
   *   normalMaterial();
   *   sphere(20);
   *   framebuffer.end();
   *
   *   background(100);
   *   // Draw the framebuffer to the main canvas
   *   image(framebuffer, -width/2, -height/2);
   * }
   * </code>
   * </div>
   *
   * @alt
   * A red, green, and blue sphere is drawn in the middle of a white rectangle
   * which starts in the top left of the canvas and whose bottom right is at
   * the user's mouse
   */
  resize(width, height) {
    this.autoSized = false;
    this.width = width;
    this.height = height;
    this._handleResize();
  }

  /**
   * Gets or sets the pixel scaling for high pixel density displays. By
   * default, the density will match that of the canvas the framebuffer was
   * created on, which will match the display density.
   *
   * Call this method with no arguments to get the current density, or pass
   * in a number to set the density.
   *
   * @method pixelDensity
   * @param {Number} [density] A scaling factor for the number of pixels per
   * side of the framebuffer
   */
  pixelDensity(density) {
    if (density) {
      this.autoSized = false;
      this.density = density;
      this._handleResize();
    } else {
      return this.density;
    }
  }

  /**
   * Gets or sets whether or not this framebuffer will automatically resize
   * along with the canvas it's attached to in order to match its size.
   *
   * Call this method with no arguments to see if it is currently auto-sized,
   * or pass in a boolean to set this property.
   *
   * @method autoSized
   * @param {Boolean} [autoSized] Whether or not the framebuffer should resize
   * along with the canvas it's attached to
   */
  autoSized(autoSized) {
    if (autoSized === undefined) {
      return this.autoSized;
    } else {
      this.autoSized = autoSized;
      this._handleResize();
    }
  }

  /**
   * Checks the capabilities of the current WebGL environment to see if the
   * settings supplied by the user are capable of being fulfilled. If they
   * are not, warnings will be logged and the settings will be changed to
   * something close that can be fulfilled.
   *
   * @private
   */
  _checkIfFormatsAvailable() {
    const gl = this.gl;

    if (
      this.useDepth &&
      this.target.webglVersion === constants.WEBGL &&
      !gl.getExtension('WEBGL_depth_texture')
    ) {
      console.warn(
        'Unable to create depth textures in this environment. Falling back ' +
          'to a framebuffer without depth.'
      );
      this.useDepth = false;
    }

    if (
      this.useDepth &&
      this.target.webglVersion === constants.WEBGL &&
      this.depthFormat === constants.FLOAT
    ) {
      console.warn(
        'FLOAT depth format is unavailable in WebGL 1. ' +
          'Defaulting to UNSIGNED_INT.'
      );
      this.depthFormat = constants.UNSIGNED_INT;
    }

    if (![
      constants.UNSIGNED_BYTE,
      constants.FLOAT,
      constants.HALF_FLOAT
    ].includes(this.format)) {
      console.warn(
        'Unknown Framebuffer format. ' +
          'Please use UNSIGNED_BYTE, FLOAT, or HALF_FLOAT. ' +
          'Defaulting to UNSIGNED_BYTE.'
      );
      this.format = constants.UNSIGNED_BYTE;
    }
    if (this.useDepth && ![
      constants.UNSIGNED_INT,
      constants.FLOAT
    ].includes(this.depthFormat)) {
      console.warn(
        'Unknown Framebuffer depth format. ' +
          'Please use UNSIGNED_INT or FLOAT. Defaulting to FLOAT.'
      );
      this.depthFormat = constants.FLOAT;
    }

    const support = checkWebGLCapabilities(this.target._renderer);
    if (!support.float && this.format === constants.FLOAT) {
      console.warn(
        'This environment does not support FLOAT textures. ' +
          'Falling back to UNSIGNED_BYTE.'
      );
      this.format = constants.UNSIGNED_BYTE;
    }
    if (
      this.useDepth &&
      !support.float &&
      this.depthFormat === constants.FLOAT
    ) {
      console.warn(
        'This environment does not support FLOAT depth textures. ' +
          'Falling back to UNSIGNED_INT.'
      );
      this.depthFormat = constants.UNSIGNED_INT;
    }
    if (!support.halfFloat && this.format === constants.HALF_FLOAT) {
      console.warn(
        'This environment does not support HALF_FLOAT textures. ' +
          'Falling back to UNSIGNED_BYTE.'
      );
      this.format = constants.UNSIGNED_BYTE;
    }

    if (
      this.channels === constants.RGB &&
      [constants.FLOAT, constants.HALF_FLOAT].includes(this.format)
    ) {
      console.warn(
        'FLOAT and HALF_FLOAT formats do not work cross-platform with only ' +
          'RGB channels. Falling back to RGBA.'
      );
      this.channels = constants.RGBA;
    }
  }

  /**
   * Creates new textures and renderbuffers given the current size of the
   * framebuffer.
   *
   * @private
   */
  _recreateTextures() {
    const gl = this.gl;

    this._updateSize();

    const prevBoundTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const prevBoundFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);

    const colorTexture = gl.createTexture();
    if (!colorTexture) {
      throw new Error('Unable to create color texture');
    }
    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    const colorFormat = this._glColorFormat();
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      colorFormat.internalFormat,
      this.width * this.density,
      this.height * this.density,
      0,
      colorFormat.format,
      colorFormat.type,
      null
    );
    this.colorTexture = colorTexture;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      colorTexture,
      0
    );

    if (this.useDepth) {
      // Create the depth texture
      const depthTexture = gl.createTexture();
      if (!depthTexture) {
        throw new Error('Unable to create depth texture');
      }
      const depthFormat = this._glDepthFormat();
      gl.bindTexture(gl.TEXTURE_2D, depthTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        depthFormat.internalFormat,
        this.width * this.density,
        this.height * this.density,
        0,
        depthFormat.format,
        depthFormat.type,
        null
      );

      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.TEXTURE_2D,
        depthTexture,
        0
      );
      this.depthTexture = depthTexture;
    }

    // Create separate framebuffer for antialiasing
    if (this.antialias) {
      this.colorRenderbuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorRenderbuffer);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        Math.max(
          0,
          Math.min(this.antialiasSamples, gl.getParameter(gl.MAX_SAMPLES))
        ),
        colorFormat.internalFormat,
        this.width * this.density,
        this.height * this.density
      );

      if (this.useDepth) {
        const depthFormat = this._glDepthFormat();
        this.depthRenderbuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRenderbuffer);
        gl.renderbufferStorageMultisample(
          gl.RENDERBUFFER,
          Math.max(
            0,
            Math.min(this.antialiasSamples, gl.getParameter(gl.MAX_SAMPLES))
          ),
          depthFormat.internalFormat,
          this.width * this.density,
          this.height * this.density
        );
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.aaFramebuffer);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.RENDERBUFFER,
        this.colorRenderbuffer
      );
      if (this.useDepth) {
        gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.RENDERBUFFER,
          this.depthRenderbuffer
        );
      }
    }

    if (this.useDepth) {
      this.depth = new FramebufferTexture(this, 'depthTexture');
      const depthFilter = gl.NEAREST;
      this.depthP5Texture = new p5.Texture(
        this.target._renderer,
        this.depth,
        {
          minFilter: depthFilter,
          magFilter: depthFilter
        }
      );
      this.target._renderer.textures.set(this.depth, this.depthP5Texture);
    }

    this.color = new FramebufferTexture(this, 'colorTexture');
    const filter = this.textureFiltering === constants.LINEAR
      ? gl.LINEAR
      : gl.NEAREST;
    this.colorP5Texture = new p5.Texture(
      this.target._renderer,
      this.color,
      {
        glMinFilter: filter,
        glMagFilter: filter
      }
    );
    this.target._renderer.textures.set(this.color, this.colorP5Texture);

    gl.bindTexture(gl.TEXTURE_2D, prevBoundTexture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevBoundFramebuffer);
  }

  /**
   * To create a WebGL texture, one needs to supply three pieces of information:
   * the type (the data type each channel will be stored as, e.g. int or float),
   * the format (the color channels that will each be stored in the previously
   * specified type, e.g. rgb or rgba), and the internal format (the specifics
   * of how data for each channel, in the aforementioned type, will be packed
   * together, such as how many bits to use, e.g. RGBA32F or RGB565.)
   *
   * The format and channels asked for by the user hint at what these values
   * need to be, and the WebGL version affects what options are avaiable.
   * This method returns the values for these three properties, given the
   * framebuffer's settings.
   *
   * @private
   */
  _glColorFormat() {
    let type, format, internalFormat;
    const gl = this.gl;

    if (this.format === constants.FLOAT) {
      type = gl.FLOAT;
    } else if (this.format === constants.HALF_FLOAT) {
      type = this.target.webglVersion === constants.WEBGL2
        ? gl.HALF_FLOAT
        : gl.getExtension('OES_texture_half_float').HALF_FLOAT_OES;
    } else {
      type = gl.UNSIGNED_BYTE;
    }

    if (this.channels === constants.RGBA) {
      format = gl.RGBA;
    } else {
      format = gl.RGB;
    }

    if (this.target.webglVersion === constants.WEBGL2) {
      // https://webgl2fundamentals.org/webgl/lessons/webgl-data-textures.html
      const table = {
        [gl.FLOAT]: {
          [gl.RGBA]: gl.RGBA32F
          // gl.RGB32F is not available in Firefox without an alpha channel
        },
        [gl.HALF_FLOAT]: {
          [gl.RGBA]: gl.RGBA16F
          // gl.RGB16F is not available in Firefox without an alpha channel
        },
        [gl.UNSIGNED_BYTE]: {
          [gl.RGBA]: gl.RGBA8, // gl.RGBA4
          [gl.RGB]: gl.RGB8 // gl.RGB565
        }
      };
      internalFormat = table[type][format];
    } else if (this.format === constants.HALF_FLOAT) {
      internalFormat = gl.RGBA;
    } else {
      internalFormat = format;
    }

    return { internalFormat, format, type };
  }

  /**
   * To create a WebGL texture, one needs to supply three pieces of information:
   * the type (the data type each channel will be stored as, e.g. int or float),
   * the format (the color channels that will each be stored in the previously
   * specified type, e.g. rgb or rgba), and the internal format (the specifics
   * of how data for each channel, in the aforementioned type, will be packed
   * together, such as how many bits to use, e.g. RGBA32F or RGB565.)
   *
   * This method takes into account the settings asked for by the user and
   * returns values for these three properties that can be used for the
   * texture storing depth information.
   *
   * @private
   */
  _glDepthFormat() {
    let type, format, internalFormat;
    const gl = this.gl;

    if (this.depthFormat === constants.FLOAT) {
      type = gl.FLOAT;
    } else {
      type = gl.UNSIGNED_INT;
    }

    format = gl.DEPTH_COMPONENT;

    if (this.target.webglVersion === constants.WEBGL2) {
      if (this.depthFormat === constants.FLOAT) {
        internalFormat = gl.DEPTH_COMPONENT32F;
      } else {
        internalFormat = gl.DEPTH_COMPONENT24;
      }
    } else {
      internalFormat = gl.DEPTH_COMPONENT;
    }

    return { internalFormat, format, type };
  }

  /**
   * A method that will be called when recreating textures. If the framebuffer
   * is auto-sized, it will update its width, height, and density properties.
   *
   * @private
   */
  _updateSize() {
    if (this.autoSized) {
      this.width = this.target.width;
      this.height = this.target.height;
      this.density = this.target.pixelDensity();
    }
  }

  /**
   * Called when the canvas that the framebuffer is attached to resizes. If the
   * framebuffer is auto-sized, it will update its textures to match the new
   * size.
   *
   * @private
   */
  _canvasSizeChanged() {
    if (this.autoSized) {
      this._handleResize();
    }
  }

  /**
   * Called when the size of the framebuffer has changed (either by being
   * manually updated or from auto-size updates when its canvas changes size.)
   * Old textures and renderbuffers will be deleted, and then recreated with the
   * new size.
   *
   * @private
   */
  _handleResize() {
    const oldColor = this.color;
    const oldDepth = this.depth;
    const oldColorRenderbuffer = this.colorRenderbuffer;
    const oldDepthRenderbuffer = this.depthRenderbuffer;

    this._deleteTexture(oldColor);
    if (oldDepth) this._deleteTexture(oldDepth);
    const gl = this.gl;
    if (oldColorRenderbuffer) gl.deleteRenderbuffer(oldColorRenderbuffer);
    if (oldDepthRenderbuffer) gl.deleteRenderbuffer(oldDepthRenderbuffer);

    this._recreateTextures();
    this.defaultCamera._resize();
  }

  /**
   * Creates and returns a new
   * <a href="#/p5.FramebufferCamera">p5.FramebufferCamera</a> to be used
   * while drawing to this framebuffer. The camera will be set as the
   * currently active camera.
   *
   * @method createCamera
   * @returns {p5.Camera} A new camera
   */
  createCamera() {
    const cam = new FramebufferCamera(this);
    cam._computeCameraDefaultSettings();
    cam._setDefaultCamera();
    this.target._renderer._curCamera = cam;
    return cam;
  }

  /**
   * Given a raw texture wrapper, delete its stored texture from WebGL memory,
   * and remove it from p5's list of active textures.
   *
   * @param {p5.FramebufferTexture} texture
   * @private
   */
  _deleteTexture(texture) {
    const gl = this.gl;
    gl.deleteTexture(texture.rawTexture());

    this.target._renderer.textures.delete(texture);
  }

  /**
   * Removes the framebuffer and frees its resources.
   *
   * @method remove
   *
   * @example
   * <div>
   * <code>
   * let framebuffer;
   * function setup() {
   *   createCanvas(100, 100, WEBGL);
   * }
   *
   * function draw() {
   *   const useFramebuffer = (frameCount % 120) > 60;
   *   if (useFramebuffer && !framebuffer) {
   *     // Create a new framebuffer for us to use
   *     framebuffer = createFramebuffer();
   *   } else if (!useFramebuffer && framebuffer) {
   *     // Free the old framebuffer's resources
   *     framebuffer.remove();
   *     framebuffer = undefined;
   *   }
   *
   *   background(255);
   *   if (useFramebuffer) {
   *     // Draw to the framebuffer
   *     framebuffer.begin();
   *     background(255);
   *     rotateX(frameCount * 0.01);
   *     rotateY(frameCount * 0.01);
   *     fill(255, 0, 0);
   *     box(30);
   *     framebuffer.end();
   *
   *     image(framebuffer, -width/2, -height/2);
   *   }
   * }
   * </code>
   * </div>
   *
   * @alt
   * A rotating red cube blinks on and off every second.
   */
  remove() {
    const gl = this.gl;
    this._deleteTexture(this.color);
    if (this.depth) this._deleteTexture(this.depth);
    gl.deleteFramebuffer(this.framebuffer);
    if (this.aaFramebuffer) {
      gl.deleteFramebuffer(this.aaFramebuffer);
    }
    if (this.depthRenderbuffer) {
      gl.deleteRenderbuffer(this.depthRenderbuffer);
    }
    if (this.colorRenderbuffer) {
      gl.deleteRenderbuffer(this.colorRenderbuffer);
    }
    this.target._renderer.framebuffers.delete(this);
  }

  /**
   * Begin drawing to this framebuffer. Subsequent drawing functions to the
   * canvas the framebuffer is attached to will not be immediately visible, and
   * will instead be drawn to the framebuffer's texture. Call
   * <a href="#/p5.Framebuffer/end">end()</a> when finished to make draw
   * functions go right to the canvas again and to be able to read the
   * contents of the framebuffer's texture.
   *
   * @method begin
   *
   * @example
   * <div>
   * <code>
   * let framebuffer;
   * function setup() {
   *   createCanvas(100, 100, WEBGL);
   *   framebuffer = createFramebuffer();
   *   noStroke();
   * }
   *
   * function draw() {
   *   // Draw to the framebuffer
   *   framebuffer.begin();
   *   background(255);
   *   translate(0, 10*sin(frameCount * 0.01), 0);
   *   rotateX(frameCount * 0.01);
   *   rotateY(frameCount * 0.01);
   *   fill(255, 0, 0);
   *   box(50);
   *   framebuffer.end();
   *
   *   background(100);
   *   // Draw the framebuffer to the main canvas
   *   image(framebuffer, -50, -50, 25, 25);
   *   image(framebuffer, 0, 0, 35, 35);
   * }
   * </code>
   * </div>
   *
   * @alt
   * A video of a floating and rotating red cube is pasted twice on the
   * canvas: once in the top left, and again, larger, in the bottom right.
   */
  begin() {
    const gl = this.gl;
    this.prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    if (this.antialias) {
      // If antialiasing, draw to an antialiased renderbuffer rather
      // than directly to the texture. In end() we will copy from the
      // renderbuffer to the texture.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.aaFramebuffer);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    }
    this.prevViewport = gl.getParameter(gl.VIEWPORT);
    gl.viewport(
      0,
      0,
      this.width * this.density,
      this.height * this.density
    );
    this.target.push();

    // Apply the framebuffer's camera. This does almost what
    // RendererGL.reset() does, but this does not try to clear any buffers;
    // it only sets the camera.
    this.target.setCamera(this.defaultCamera);
    this.target._renderer.uMVMatrix.set(
      this.target._renderer._curCamera.cameraMatrix.mat4[0],
      this.target._renderer._curCamera.cameraMatrix.mat4[1],
      this.target._renderer._curCamera.cameraMatrix.mat4[2],
      this.target._renderer._curCamera.cameraMatrix.mat4[3],
      this.target._renderer._curCamera.cameraMatrix.mat4[4],
      this.target._renderer._curCamera.cameraMatrix.mat4[5],
      this.target._renderer._curCamera.cameraMatrix.mat4[6],
      this.target._renderer._curCamera.cameraMatrix.mat4[7],
      this.target._renderer._curCamera.cameraMatrix.mat4[8],
      this.target._renderer._curCamera.cameraMatrix.mat4[9],
      this.target._renderer._curCamera.cameraMatrix.mat4[10],
      this.target._renderer._curCamera.cameraMatrix.mat4[11],
      this.target._renderer._curCamera.cameraMatrix.mat4[12],
      this.target._renderer._curCamera.cameraMatrix.mat4[13],
      this.target._renderer._curCamera.cameraMatrix.mat4[14],
      this.target._renderer._curCamera.cameraMatrix.mat4[15]
    );
  }

  /**
   * After having previously called
   * <a href="#/p5.Framebuffer/begin">begin()</a>, this method stops drawing
   * functions from going to the framebuffer's texture, allowing them to go
   * right to the canvas again. After this, one can read from the framebuffer's
   * texture.
   *
   * @method end
   */
  end() {
    const gl = this.gl;
    if (this.antialias) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.aaFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
      const partsToCopy = [
        [gl.COLOR_BUFFER_BIT, this.colorP5Texture.glMagFilter]
      ];
      if (this.useDepth) {
        partsToCopy.push(
          [gl.DEPTH_BUFFER_BIT, this.depthP5Texture.glMagFilter]
        );
      }
      for (const [flag, filter] of partsToCopy) {
        gl.blitFramebuffer(
          0, 0,
          this.width * this.density, this.height * this.density,
          0, 0,
          this.width * this.density, this.height * this.density,
          flag,
          filter
        );
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.prevFramebuffer);
    gl.viewport(...this.prevViewport);
    this.target.pop();
  }

  /**
   * Run a function while drawing to the framebuffer rather than to its canvas.
   * This is equivalent to calling `framebuffer.begin()`, running the function,
   * and then calling `framebuffer.end()`, but ensures that one never
   * accidentally forgets `begin` or `end`.
   *
   * @method draw
   * @param {Function} callback A function to run that draws to the canvas. The
   * function will immediately be run, but it will draw to the framebuffer
   * instead of the canvas.
   *
   * @example
   * <div>
   * <code>
   * let framebuffer;
   * function setup() {
   *   createCanvas(100, 100, WEBGL);
   *   framebuffer = createFramebuffer();
   *   noStroke();
   * }
   *
   * function draw() {
   *   // Draw to the framebuffer
   *   framebuffer.draw(function() {
   *     background(255);
   *     translate(0, 10*sin(frameCount * 0.01), 0);
   *     rotateX(frameCount * 0.01);
   *     rotateY(frameCount * 0.01);
   *     fill(255, 0, 0);
   *     box(50);
   *   });
   *
   *   background(100);
   *   // Draw the framebuffer to the main canvas
   *   image(framebuffer, -50, -50, 25, 25);
   *   image(framebuffer, 0, 0, 35, 35);
   * }
   * </code>
   * </div>
   *
   * @alt
   * A video of a floating and rotating red cube is pasted twice on the
   * canvas: once in the top left, and again, larger, in the bottom right.
   */
  draw(callback) {
    this.begin();
    callback();
    this.end();
  }
}

/**
 * A texture with the color information of the framebuffer. Pass this (or the
 * framebuffer itself) to <a href="#/p5/texture">texture()</a> to draw it to
 * the canvas, or pass it to a shader with
 * <a href="#/p5.Shader/setUniform">setUniform()</a> to read its data.
 *
 * Since Framebuffers are controlled by WebGL, their y coordinates are stored
 * flipped compared to images and videos. When texturing with a framebuffer
 * texture, you may want to flip vertically, e.g. with
 * `plane(framebuffer.width, -framebuffer.height)`.
 *
 * @property {p5.FramebufferTexture} color
 * @for p5.Framebuffer
 *
 * @example
 * <div>
 * <code>
 * let framebuffer;
 * function setup() {
 *   createCanvas(100, 100, WEBGL);
 *   framebuffer = createFramebuffer();
 *   noStroke();
 * }
 *
 * function draw() {
 *   // Draw to the framebuffer
 *   framebuffer.begin();
 *   background(255);
 *   normalMaterial();
 *   sphere(20);
 *   framebuffer.end();
 *
 *   // Draw the framebuffer to the main canvas
 *   image(framebuffer.color, -width/2, -height/2);
 * }
 * </code>
 * </div>
 *
 * @alt
 * A red, green, and blue sphere in the middle of the canvas
 */

/**
 * A texture with the depth information of the framebuffer. If the framebuffer
 * was created with `{ depth: false }` in its settings, then this property will
 * be undefined. Pass this to <a href="#/p5/texture">texture()</a> to draw it to
 * the canvas, or pass it to a shader with
 * <a href="#/p5.Shader/setUniform">setUniform()</a> to read its data.
 *
 * Since Framebuffers are controlled by WebGL, their y coordinates are stored
 * flipped compared to images and videos. When texturing with a framebuffer
 * texture, you may want to flip vertically, e.g. with
 * `plane(framebuffer.width, -framebuffer.height)`.
 *
 * @property {p5.FramebufferTexture|undefined} depth
 * @for p5.Framebuffer
 *
 * @example
 * <div>
 * <code>
 * let framebuffer;
 * let depthShader;
 *
 * const vert = `
 * precision highp float;
 * attribute vec3 aPosition;
 * attribute vec2 aTexCoord;
 * uniform mat4 uModelViewMatrix;
 * uniform mat4 uProjectionMatrix;
 * varying vec2 vTexCoord;
 * void main() {
 *   vec4 viewModelPosition = uModelViewMatrix * vec4(aPosition, 1.0);
 *   gl_Position = uProjectionMatrix * viewModelPosition;
 *   vTexCoord = aTexCoord;
 * }
 * `;
 *
 * const frag = `
 * precision highp float;
 * varying vec2 vTexCoord;
 * uniform sampler2D depth;
 * void main() {
 *   float depthVal = texture2D(depth, vTexCoord).r;
 *   gl_FragColor = mix(
 *     vec4(1., 1., 0., 1.), // yellow
 *     vec4(0., 0., 1., 1.), // blue
 *     pow(depthVal, 6.)
 *   );
 * }
 * `;
 *
 * function setup() {
 *   createCanvas(100, 100, WEBGL);
 *   framebuffer = createFramebuffer();
 *   depthShader = createShader(vert, frag);
 *   noStroke();
 * }
 *
 * function draw() {
 *   // Draw to the framebuffer
 *   framebuffer.begin();
 *   background(255);
 *   rotateX(frameCount * 0.01);
 *   box(20, 20, 100);
 *   framebuffer.end();
 *
 *   push();
 *   shader(depthShader);
 *   depthShader.setUniform('depth', framebuffer.depth);
 *   plane(framebuffer.width, framebuffer.height);
 *   pop();
 * }
 * </code>
 * </div>
 *
 * @alt
 * A video of a rectangular prism rotating, with parts closest to the camera
 * appearing yellow and colors getting progressively more blue the farther
 * from the camera they go
 */

p5.Framebuffer = Framebuffer;

export default Framebuffer;
