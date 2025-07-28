// DIFF ARRAY
function Diff() {}

Diff.prototype = {
  diff(oldString, newString, options = {}) {
    let callback = options.callback;
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    this.options = options;

    let self = this;

    function done(value) {
      if (callback) {
        setTimeout(function() { callback(undefined, value); }, 0);
        return true;
      } else {
        return value;
      }
    }

    // Allow subclasses to massage the input prior to running
    oldString = this.castInput(oldString);
    newString = this.castInput(newString);

    oldString = this.removeEmpty(this.tokenize(oldString));
    newString = this.removeEmpty(this.tokenize(newString));

    let newLen = newString.length, oldLen = oldString.length;
    let editLength = 1;
    let maxEditLength = newLen + oldLen;
    if(options.maxEditLength) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }

    let bestPath = [{ newPos: -1, components: [] }];

    // Seed editLength = 0, i.e. the content starts with the same values
    let oldPos = this.extractCommon(bestPath[0], newString, oldString, 0);
    if (bestPath[0].newPos + 1 >= newLen && oldPos + 1 >= oldLen) {
      // Identity per the equality and tokenizer
      return done([{value: this.join(newString), count: newString.length}]);
    }

    // Main worker method. checks all permutations of a given edit length for acceptance.
    function execEditLength() {
      for (let diagonalPath = -1 * editLength; diagonalPath <= editLength; diagonalPath += 2) {
        let basePath;
        let addPath = bestPath[diagonalPath - 1],
            removePath = bestPath[diagonalPath + 1],
            oldPos = (removePath ? removePath.newPos : 0) - diagonalPath;
        if (addPath) {
          // No one else is going to attempt to use this value, clear it
          bestPath[diagonalPath - 1] = undefined;
        }

        let canAdd = addPath && addPath.newPos + 1 < newLen,
            canRemove = removePath && 0 <= oldPos && oldPos < oldLen;
        if (!canAdd && !canRemove) {
          // If this path is a terminal then prune
          bestPath[diagonalPath] = undefined;
          continue;
        }

        // Select the diagonal that we want to branch from. We select the prior
        // path whose position in the new string is the farthest from the origin
        // and does not pass the bounds of the diff graph
        if (!canAdd || (canRemove && addPath.newPos < removePath.newPos)) {
          basePath = clonePath(removePath);
          self.pushComponent(basePath.components, undefined, true);
        } else {
          basePath = addPath; // No need to clone, we've pulled it from the list
          basePath.newPos++;
          self.pushComponent(basePath.components, true, undefined);
        }

        oldPos = self.extractCommon(basePath, newString, oldString, diagonalPath);

        // If we have hit the end of both strings, then we are done
        if (basePath.newPos + 1 >= newLen && oldPos + 1 >= oldLen) {
          return done(buildValues(self, basePath.components, newString, oldString, self.useLongestToken));
        } else {
          // Otherwise track this path as a potential candidate and continue.
          bestPath[diagonalPath] = basePath;
        }
      }

      editLength++;
    }

    // Performs the length of edit iteration. Is a bit fugly as this has to support the
    // sync and async mode which is never fun. Loops over execEditLength until a value
    // is produced, or until the edit length exceeds options.maxEditLength (if given),
    // in which case it will return undefined.
    if (callback) {
      (function exec() {
        setTimeout(function() {
          if (editLength > maxEditLength) {
            return callback();
          }

          if (!execEditLength()) {
            exec();
          }
        }, 0);
      }());
    } else {
      while (editLength <= maxEditLength) {
        let ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  },

  pushComponent(components, added, removed) {
    let last = components[components.length - 1];
    if (last && last.added === added && last.removed === removed) {
      // We need to clone here as the component clone operation is just
      // as shallow array clone
      components[components.length - 1] = {count: last.count + 1, added: added, removed: removed };
    } else {
      components.push({count: 1, added: added, removed: removed });
    }
  },
  extractCommon(basePath, newString, oldString, diagonalPath) {
    let newLen = newString.length,
        oldLen = oldString.length,
        newPos = basePath.newPos,
        oldPos = newPos - diagonalPath,

        commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(newString[newPos + 1], oldString[oldPos + 1])) {
      newPos++;
      oldPos++;
      commonCount++;
    }

    if (commonCount) {
      basePath.components.push({count: commonCount});
    }

    basePath.newPos = newPos;
    return oldPos;
  },

  equals(left, right) {
    if (this.options.comparator) {
      return this.options.comparator(left, right);
    } else {
      return left === right
        || (this.options.ignoreCase && left.toLowerCase() === right.toLowerCase());
    }
  },
  removeEmpty(array) {
    let ret = [];
    for (let i = 0; i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  },
  castInput(value) {
    return value;
  },
  tokenize(value) {
    return value.split('');
  },
  join(chars) {
    return chars.join('');
  }
};

function buildValues(diff, components, newString, oldString, useLongestToken) {
  let componentPos = 0,
      componentLen = components.length,
      newPos = 0,
      oldPos = 0;

  for (; componentPos < componentLen; componentPos++) {
    let component = components[componentPos];
    if (!component.removed) {
      if (!component.added && useLongestToken) {
        let value = newString.slice(newPos, newPos + component.count);
        value = value.map(function(value, i) {
          let oldValue = oldString[oldPos + i];
          return oldValue.length > value.length ? oldValue : value;
        });

        component.value = diff.join(value);
      } else {
        component.value = diff.join(newString.slice(newPos, newPos + component.count));
      }
      newPos += component.count;

      // Common case
      if (!component.added) {
        oldPos += component.count;
      }
    } else {
      component.value = diff.join(oldString.slice(oldPos, oldPos + component.count));
      oldPos += component.count;

      // Reverse add and remove so removes are output first to match common convention
      // The diffing algorithm is tied to add then remove output and this is the simplest
      // route to get the desired output with minimal overhead.
      if (componentPos && components[componentPos - 1].added) {
        let tmp = components[componentPos - 1];
        components[componentPos - 1] = components[componentPos];
        components[componentPos] = tmp;
      }
    }
  }

  // Special case handle for when one terminal is ignored (i.e. whitespace).
  // For this case we merge the terminal into the prior string and drop the change.
  // This is only available for string mode.
  let lastComponent = components[componentLen - 1];
  if (componentLen > 1
      && typeof lastComponent.value === 'string'
      && (lastComponent.added || lastComponent.removed)
      && diff.equals('', lastComponent.value)) {
    components[componentLen - 2].value += lastComponent.value;
    components.pop();
  }

  return components;
}

function clonePath(path) {
  return { newPos: path.newPos, components: path.components.slice(0) };
}

const arrayDiff = new Diff();
arrayDiff.tokenize = function(value) {
  return value.slice();
};
arrayDiff.join = arrayDiff.removeEmpty = function(value) {
  return value;
};

function diffArrays(oldArr, newArr, callback) { return arrayDiff.diff(oldArr, newArr, callback); }

// END DIFF ARRAY

function splitPartialSubtitles(
  { previousText, previousIndexes: oldCutPositions },
  newText,
  computeIfTextIsTooLong,
) {
  if (!newText) {
    return {
      previousText,
      previousIndexes: oldCutPositions,
    }
  }

  const previousTextSplitBySpace = previousText.split(" ")

  const newTextSplitBySpace = newText.split(" ")
  const diff_list = diffArrays(previousTextSplitBySpace, newTextSplitBySpace, {
    comparator: isSameWord,
  })
  let indexInNewText = 0
  let numberOfRemove = 0
  let newCutPositions = [...oldCutPositions]

  for (const diff of diff_list) {
    if (diff.removed) {
      newCutPositions = incrementIndexes(
        newCutPositions,
        indexInNewText,
        -diff.count,
      )

      numberOfRemove += diff.count
    } else if (diff.added) {
      newCutPositions = incrementIndexes(
        newCutPositions,
        indexInNewText - numberOfRemove,
        diff.count,
      )
      indexInNewText += diff.count
    } else {
      indexInNewText += diff.count
    }
  }

  const lastLinePosition = newCutPositions.at(-1) ?? 0
  let lastLine = newTextSplitBySpace.slice(lastLinePosition).join(" ")
  if (computeIfTextIsTooLong(lastLine)) {
    const offset = (newCutPositions.at(-1) ?? 0) - (oldCutPositions.at(-1) ?? 0)
    const realLastLinePosition = previousTextSplitBySpace.length + offset
    const realLastLine = newTextSplitBySpace
      .slice(realLastLinePosition)
      .join(" ")
    const cutPositionsForLastLine = getIndexesWhereToCutText(
      realLastLine,
      computeIfTextIsTooLong,
    )
    newCutPositions.push(realLastLinePosition)
    newCutPositions = newCutPositions.concat(cutPositionsForLastLine)
  }

  return {
    previousIndexes: newCutPositions,
    previousText: newText,
  }
}

function incrementIndexes(indexes, from, increment) {
  return indexes.map((index) => (index > from ? index + increment : index))
}

export function getIndexesWhereToCutText(text, computeIfTextIsTooLong) {
  const splitText = text.split(" ")
  if (!computeIfTextIsTooLong(text) || splitText.length <= 1) {
    return []
  } else {
    let i
    for (i = 0; i < splitText.length; i++) {
      const currentText = splitText.slice(0, i).join(" ")
      if (computeIfTextIsTooLong(currentText)) {
        break
      }
    }

    return [i - 1].concat(
      incrementIndexes(
        getIndexesWhereToCutText(
          splitText.slice(i - 1).join(" "),
          computeIfTextIsTooLong,
        ),
        0,
        i - 1,
      ),
    )
  }
}

function isSameWord(word1, word2) {
  const w1Normalized = word1
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
  const w2Normalized = word2
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")

  const word1Length = w1Normalized.length
  const word2Length = w2Normalized.length

  const shortestLength = Math.min(word1Length, word2Length)

  let numberOfSameChars = 0
  for (let i = 0; i < shortestLength; i++) {
    if (w1Normalized[i].toLowerCase() === w2Normalized[i].toLowerCase()) {
      numberOfSameChars++
    }
  }

  const similarity = numberOfSameChars / word1Length
  return similarity > 0.8
}

export class SubtitleDrawer {
  constructor(
    canvas,
    {
      fontSize = 40,
      lineHeight = 50,
      color = "white",
      font = "Arial",
      paddingInline = 100,
      paddingVertical = 490,
    } = {},
  ) {
    this.canvas = canvas

    this.fontSize = fontSize
    this.lineHeight = lineHeight
    this.color = color
    this.font = font
    this.paddingInline = paddingInline
    this.paddingVertical = paddingVertical

    this.isResizing = false
    // set width canvas equal to the width of the parent element
    //this.canvas.width = this.canvas.clientWidth
    //// set height canvas equal to the height of the parent element
    //this.canvas.height = this.canvas.clientHeight
    //this.resizeObserverContainer = new ResizeObserver(
    //  function (entries) {
    //    this.isResizing = true
    //    this.canvas.width = this.canvas.clientWidth
    //    this.canvas.height = this.canvas.clientHeight
    //    //this.draw()
    //    this.onResize()
    //    this.isResizing = false
    //  }.bind(this),
    //)

    //this.resizeObserverContainer.observe(this.canvas)
  }

  resetDrawing() {
    const ctx = this.canvas.getContext("2d")
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  drawText(text, x, y) {
    const ctx = this.canvas.getContext("2d")
    ctx.font = `${this.fontSize}px ${this.font}`
    ctx.fillStyle = this.color
    ctx.fillText(text, x + this.paddingInline, y)
    //debugger
  }

  // those two methods can be refactored into one methods "drawLine(text, lineNumber)"
  drawFirstLine(text) {
    this.drawText(text, 0, this.fontSize + this.paddingVertical)
  }

  drawSecondLine(text) {
    this.drawText(
      text,
      0,
      this.fontSize + this.lineHeight + this.paddingVertical,
    )
  }

  onResize() {
    return
  }
}

export class SubtitleScroller extends SubtitleDrawer {
  constructor(
    canvas,
    { fontSize = 40, lineHeight = 50, color = "white", font = "Arial" } = {},
  ) {
    super(canvas, { fontSize, lineHeight, color, font })

    this.currentState = { previousText: "", previousIndexes: [] }
    this.previousState = { previousText: "", previousIndexes: [] }
  }

  resetAll() {
    this.currentState = { previousText: "", previousIndexes: [] }
    this.previousState = { previousText: "", previousIndexes: [] }
  }

  onResize() {
    const currentText = this.currentState.previousText
    this.resetAll()
    this.currentState = splitPartialSubtitles(
      this.currentState,
      currentText.trim(),
      this.computeIfTextIsTooLong.bind(this),
    )

    this.draw()
  }

  newPartial(text) {
    if (this.isResizing) {
      return
    }

    const currentText = text
    this.currentState = splitPartialSubtitles(
      this.currentState,
      currentText.trim(),
      this.computeIfTextIsTooLong.bind(this),
    )
    this.draw()
  }

  resetState() {
    this.previousState = this.currentState
    this.currentState = { previousText: "", previousIndexes: [] }
  }

  draw() {
    this.resetDrawing()
    let firstLine = ""
    let secondLine = ""

    switch (this.currentState.previousIndexes.length) {
      case 0:
        firstLine = this._getLastLineOfState(this.previousState)
        secondLine = this.currentState.previousText
        break
      default:
        firstLine = this._getSecondLastLineOfState(this.currentState)
        secondLine = this._getLastLineOfState(this.currentState)
        break
    }

    this.drawFirstLine(firstLine)
    this.drawSecondLine(secondLine)
  }

  _getLastLineOfState(state) {
    if (state.previousIndexes.length === 0) {
      return state.previousText
    }

    const lastIndex = state.previousIndexes[state.previousIndexes.length - 1]

    return state.previousText.split(" ").slice(lastIndex).join(" ")
  }

  _getSecondLastLineOfState(state) {
    if (state.previousIndexes.length === 0) {
      return ""
    }

    const lastIndex = state.previousIndexes[state.previousIndexes.length - 1]
    let beforeLastIndex = 0

    if (state.previousIndexes.length > 1) {
      beforeLastIndex = state.previousIndexes[state.previousIndexes.length - 2]
    }

    return state.previousText
      .split(" ")
      .slice(beforeLastIndex, lastIndex)
      .join(" ")
  }

  newFinal(text) {
    if (this.isResizing) {
      return
    }

    this.currentState = splitPartialSubtitles(
      this.currentState,
      text.trim(),
      this.computeIfTextIsTooLong.bind(this),
    )
    this.draw()
    this.resetState()
  }

  computeIfTextIsTooLong(text) {
    const ctx = this.canvas.getContext("2d")
    const maxWidth = this.canvas.width - 2 * this.paddingInline
    const width = ctx.measureText(text).width
    return width > maxWidth
  }
}
