import type { Train } from './types'

type TrainIdentitySource = Pick<Train, 'number' | 'name' | 'category'>

function clean(value: string | undefined): string {
  return value?.trim() ?? ''
}

function numberWithoutCategory(number: string, category: string): string {
  if (!number || !category) return number
  const prefix = `${category.toLocaleUpperCase()} `
  return number.toLocaleUpperCase().startsWith(prefix)
    ? number.slice(prefix.length).trim()
    : number
}

function categoryAndNumber(category: string, number: string): string {
  if (!category) return number
  if (!number) return category
  if (number.toLocaleUpperCase() === category.toLocaleUpperCase()) return number

  const bareNumber = numberWithoutCategory(number, category)
  return bareNumber === number ? `${category} ${number}` : number
}

/**
 * Produce the two-level label used throughout the map UI.
 *
 * Named services lead with the public name (for example an IC train name).
 * Otherwise the commercial category becomes the recognisable local line label
 * (for example S2). The national number remains available as the exact
 * operational reference without duplicating a category already in that number.
 */
export function getTrainIdentity(train: TrainIdentitySource): {
  primary: string
  secondary: string | null
} {
  const name = clean(train.name)
  const category = clean(train.category)
  const number = clean(train.number)

  if (name) {
    const reference = categoryAndNumber(category, number)
    return { primary: name, secondary: reference || null }
  }

  if (category) {
    const bareNumber = numberWithoutCategory(number, category)
    return {
      primary: category,
      secondary: bareNumber && bareNumber !== category ? bareNumber : null,
    }
  }

  return { primary: number || '—', secondary: null }
}
