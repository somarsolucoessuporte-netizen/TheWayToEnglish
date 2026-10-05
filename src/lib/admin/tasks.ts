/** "oral" or no value = the task uses no picture; anything else = it does. */
export function usesImage(imageDependency: string | undefined): boolean {
  return !!imageDependency && imageDependency !== "oral";
}
