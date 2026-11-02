'use strict';

// Registers every job handler and event dispatch target.
require('../../integrations/mail/mailer');
require('../dispatch');
require('../../modules/webhooks/webhooks.service');
require('../../modules/workflows/engine');
require('../../modules/communications/communications.service');
require('../../modules/imports/imports.service');
require('../../modules/tickets/sla.job');
require('../../modules/reports/scheduled.job');
require('./maintenance');
