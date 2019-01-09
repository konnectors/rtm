// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://7b6562ec14244978829dfda71634b275:9b5bbe1f11984b4eb4f3d8ddb0f56b71@sentry.cozycloud.cc/86'

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

const moment = require('moment')

const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})

const baseUrl = 'http://www.rtm.fr/'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.cardNumber, fields.dob)
  log('info', 'Successfully logged in')

  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Fetching the list of documents')
  const $ = await request(
    `${baseUrl}/guide-voyageur/acheter/attestation-dabonnement/attestation-dabonnements`
  )

  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    // this is a bank identifier which will be used to link bills to bank operations.
    // It is not case sensitive.
    identifiers: ['Gestionnaire Le Metro FR'],
    contentType: 'application/pdf'
  })
}

function authenticate(cardNumber, cozyBirthDate) {
  // Transform the dob field from cozy (YYYY-MM-DD) to the required format (DD/MM/YYYY)
  let [birthYear, birthMonth, birthDay] = cozyBirthDate.split('-')
  let birthDate = `${birthDay}/${birthMonth}/${birthYear}`

  return signin({
    url: `${baseUrl}/guide-voyageur/acheter/attestation-abonnement`,
    formSelector: 'form#cartetranspasse1',
    formData: { num: cardNumber, 'date[date]': birthDate },

    validate: (statusCode, $) => {
      // The "login" on rtm.fr for the bill area is a bit weird as we always end on a 200.
      // Instead we try to find the table containing all the data we want to scrape
      if ($('.sticky-enabled').length >= 1) {
        return true
      } else {
        log('error', 'Invalid credentials')
        log('error', $('.messages').text())
        return false
      }
    }
  })
}

function parseDocuments($) {
  const docs = scrape(
    $,
    {
      date: {
        sel: 'td:nth-child(1)',
        parse: text => moment(text, 'DD/MM/YYYY')
      },
      title: {
        sel: 'td:nth-child(2)'
      },
      amount: {
        sel: 'td:nth-child(3)',
        parse: text => parseFloat(text.match(/(\d+(.\d+)?)/)[1])
      },
      fileurl: {
        sel: 'td:nth-child(4) > a:nth-child(1)',
        attr: 'href',
        parse: url =>
          `${baseUrl}/printpdf/node/2071603?nid=` +
          parseInt(url.match(/\/editer-le-recu\?nid=(\d+)/)[1])
      }
    },
    'tr.odd, tr.even'
  )
  return docs.map(doc => ({
    ...doc,
    currency: 'EUR',
    vendor: 'RTM',
    filename: doc.date.format('YYYY-MM-DD') + '_' + doc.amount + '.pdf',
    date: doc.date.toDate(),
    metadata: {
      // it can be interesting that we add the date of import. This is not mandatory but may be
      // usefull for debugging or data migration
      importDate: new Date(),
      // document version, usefull for migration after change of document structure
      version: 1
    }
  }))
}
