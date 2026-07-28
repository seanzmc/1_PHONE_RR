const NY_TZ = 'America/New_York'

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function businessDate(instant: Date): string {
  return fmt.format(instant)
}

export function periodKey(businessDateStr: string): string {
  return businessDateStr.slice(0, 7)
}
