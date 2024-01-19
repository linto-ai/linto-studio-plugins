const txt1EN = "Pastry is a dough of flour, water and shortening that may be savoury or sweetened. Sweetened pastries are often described as bakers' confectionery."
export const breakTxt1EN = breakText(txt1EN)

const txt1FR = "Les animaux sont des organismes vivants qui se nourrissent de matières organiques, respirent de l'oxygène et sont capables de se déplacer."
export const breakTxt1FR = breakText(txt1FR)

const txt2EN = "The quick brown fox jumps over the lazy dog. This sentence is often used as a typing test because it uses every letter in the English alphabet."
export const txt2FR = "Portez ce vieux whisky au juge blond qui fume. Cette phrase est souvent utilisée comme test de dactylographie car elle utilise toutes les lettres de l'alphabet français."
export const breakTxt2EN = breakText(txt2EN)
export const breakTxt2FR = breakText(txt2FR)

const txt3EN = "Programming is the process of creating a set of instructions that tell a computer how to perform a task."
export const txt3FR = "La programmation est le processus de création d'un ensemble d'instructions qui indiquent à un ordinateur comment effectuer une tâche."

function breakText (text) {
  const phrases = text.split('.')
  const res = []
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i]
    const withoutPunctuation = phrase.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '').toLowerCase()
    const wordsWithoutPunctuation = withoutPunctuation.split(' ')
    if (wordsWithoutPunctuation.length > 0) {
      res.push({ words: wordsWithoutPunctuation, withPunctuation: phrase })
    }
  }

  return res
}