'use strict';

// Will normalize incoming Bitbucket webhook payloads into Slack compatible, display-friendly formats,
// proxying the call to the configured Slack endpoint.
//
// Adapted from https://github.com/lfilho/bitbucket-slack-pr-hook/blob/master/lib/bitbucketParser.js

var https = require('https');

//------------------------------
// Required Configuration
//------------------------------

// Your Slack endpoint path-- eg /services/XXXXXXXXXXXXX/XXXXXXXXXXXX
var slackPath = 'REPLACE_ME_WITH_ENDPOINT_PATH';

// A simple username lookup for @mentions in Slack
var BITBUCKET_TO_SLACK_USERS = {
    'bitbucket_username': 'slack_username',
    'etc': 'etc'
};



//------------------------------
// AWS Lambda Endpoint Config
//------------------------------

// Create this as an AWS Lambda function (can be pasted to inline editor), and configure an API Gateway endpoint.
// The endpoint should be configured as a POST receiver for the incoming Bitbucket webhook. Provide the generated
// URL to Bitbucket's Webhooks (Settings -> Webhooks -> Add Webhook ...).
//
//
// NOTE: The API Gateway endpoint must be configured to accept a Method Request -> Header -> Value: 'X-Event-Key'
// This is how Bitbucket provides the event name to the recipient. Once configured, this header will then become
// available to be transformed into a Lambda function parameter for use in the script. It should be setup with
// the Integration Request -> Body Mapping Template (application/json) value below:
//
// {
//   "payload" : $input.json('$'),
//   "_event_key" : "$input.params('X-Event-Key')"
// }
//
// See also: http://stackoverflow.com/questions/34286197/how-to-access-header-in-aws-lambda



//------------------------------
// BitBucket Processing
//------------------------------


/**
 * Examine the message from Bitbucket to determine the message to send
 * to the notification service. See [0] for more information regarding available events..
 *
 * [0]: https://confluence.atlassian.com/bitbucket/event-payloads-740262817.html
 *
 * @param  {object} data        Payload of the webhook HTTP request
 * @param  {string} eventKey    Event-Key identified by webhook HTTP header
 * @param  {object} appContext  The Lambda context in which to invoke callbacks, etc
 */
function generateMessage(data, eventKey, appContext) {

    console.info('Generating message for eventKey:', eventKey);

    //------------------------------
    // Validation
    //------------------------------

    var parsedKey = eventKey || '',
        delimiter = parsedKey.indexOf(':'),
        context = parsedKey.substring(0, delimiter);

    parsedKey = parsedKey.substring(delimiter + 1, parsedKey.length);

    var supportedContexts = ['pullrequest', 'repo'],
        supportedEvents = {
            'pullrequest': [
                'created',
                'updated',
                'rejected',
                'fulfilled',
                'approved',
                'unapproved',
                'comment_created',
                'comment_updated',
                'comment_deleted'
            ],
            'repo': [
                'push'
            ]
        };


    if (supportedContexts.indexOf(context) < 0 || !parsedKey || supportedEvents[context].indexOf(parsedKey) < 0) {
        appContext.fail('An unknown event type was submitted: ' + eventKey);
        return;
    }


    //------------------------------
    // Formatting helpers
    //------------------------------

    var helper = {

        capitalize: function(string) {
            return string.charAt(0).toUpperCase() + string.slice(1);
        },

        truncate: function(string, maxLength, showEllipsis) {
            maxLength = maxLength || 100;

            if (string.length > maxLength) {
                return string.substring(0, maxLength) + (showEllipsis !== false ? ' [...]' : '');
            }

            return string;
        },

        getPossiblyUndefinedKeyValue: function(obj, keySequence) {
            var keys = keySequence.split('.');

            while (obj && keys.length) {
                obj = obj[keys.shift()];
            }

            return obj || undefined;
        },

        COLORS: {
            red: '#e74c3c',
            green: '#2ecc71',
            blue: '#3498db',
            yellow: '#f1c40f'
        },

        FEATURE_SWITCH: {
            mentionReviewers: true //false
        }
    };


    //------------------------------
    // PR Event Base Formatting
    //------------------------------

    function pullrequestBaseHandler(event) {

        /**
         * Extracts the payload recieved from Bitbucket outgoing hooks.
         *
         * @param  {object} event Pull Request Event
         * @return {object}       Data object mapped with key information
         */
        var extractPrData = function(event) {

            console.info('Extracting Pull Request data');

            var getKey = helper.getPossiblyUndefinedKeyValue.bind(this, event);

            var data = {
                prAuthor: getKey('pullrequest.author.display_name'),
                prAuthorUsername: getKey('pullrequest.author.username'),
                prUrl: getKey('pullrequest.links.html.href'),
                prTitle: getKey('pullrequest.title'),

                actor: getKey('actor.display_name'),
                actorUserName: getKey('actor.username'),

                repoName: getKey('pullrequest.source.repository.name'),
                repoSourceName: getKey('pullrequest.source.branch.name'),
                repoDestinationName: getKey('pullrequest.destination.branch.name'),

                reason: getKey('repository.reason'),
                state: getKey('repository.state'),
                description: getKey('repository.description'),

                commentUrl: getKey('comment.links.html.href'),
                commentContentRaw: getKey('comment.content.raw'),

                reviewers: getKey('pullrequest.reviewers')
            };

            return data;
        };

        var data = extractPrData(event);

        var result = {
            link_names: 1,
            mrkdwn: true,
            attachments: [{
                title: data.prTitle,
                title_link: data.prUrl,
                color: helper.COLORS.blue,
                fields: [],
                mrkdwn_in: ['pretext', 'fields']
            }]
        };

        if (data.reason) {
            result.attachments[0].fields.push({
                title: 'Reason',
                value: data.reason
            });
        }

        return {
            data: data,
            result: result
        };
    }

    //------------------------------
    // Repo Event Base Formatting
    //------------------------------

    function repoBaseHandler(event) {

        /**
         * Extracts the payload recieved from Bitbucket outgoing hooks.
         *
         * @param  {object} event Repository Event
         * @return {object}       Data object mapped with key information
         */
        var extractRepoData = function(event) {

            console.info('Extracting Push data');

            var getKey = helper.getPossiblyUndefinedKeyValue.bind(this, event);

            var data = {
                actor: getKey('actor.display_name'),
                repoName: getKey('repository.name'),
                reason: getKey('repository.reason'),
                state: getKey('repository.state'),
                description: getKey('repository.description'),
                commentUrl: getKey('comment.links.html.href'),
                commentContentRaw: getKey('comment.content.raw'),
            };

            var changes = event.push.changes,
                pushInfo = changes && changes[0] ? changes[0].new || changes[0].old : undefined;

            if (pushInfo) {
                data.pushType = pushInfo.type;
                data.pushTarget = pushInfo.name;
                data.pushForced = changes[0].forced;
                data.pushCommits = changes[0].commits;
            }

            return data;
        };

        var data = extractRepoData(event);

        var result = {
            link_names: 1,
            mrkdwn: true,
            attachments: [{
                color: helper.COLORS.blue,
                fields: [],
                mrkdwn_in: ['pretext', 'fields']
            }]
        };

        if (data.reason) {
            result.attachments[0].fields.push({
                title: 'Reason',
                value: data.reason
            });
        }

        return {
            data: data,
            result: result
        };
    }


    //------------------------------
    // Formatting gateway
    //------------------------------

    var messageHandlers = {

        //----------------------------------
        // Pull Request Handlers
        // See also: https://confluence.atlassian.com/bitbucket/event-payloads-740262817.html#EventPayloads-PullRequestEvents
        //-----------------------------------

        pullrequest: {

            created: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Created: ' + data.prTitle;
                result.attachments[0].pretext = '_Pull-Request: *Created*_';

                result.attachments[0].fields.push({
                    title: 'Repo / Branches:',
                    value: data.repoName + ' (' + data.repoSourceName + ' → ' + data.repoDestinationName + ')',
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                if (helper.FEATURE_SWITCH.mentionReviewers && data.reviewers && data.reviewers.length > 0) {
                    var reviewersStr = '';
                    for (var i = 0; i < data.reviewers.length; i++) {
                        reviewersStr += ' @' + BITBUCKET_TO_SLACK_USERS[data.reviewers[i].username];
                    }
                    result.attachments[0].fields.push({
                        title: 'Reviewers:',
                        value: reviewersStr.trim()
                    });
                }

                return result;
            },

            updated: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Updated:' + data.prTitle;
                result.attachments[0].pretext = '_Pull-Request: *Updated*_';

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Updated By',
                    value: data.actor,
                    short: true
                });

                return result;
            },

            approved: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Approved:' + data.prTitle;
                result.attachments[0].pretext = '_Pull-Request: *Approved*_';
                result.attachments[0].color = helper.COLORS.green;

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Approved By',
                    value: data.actor,
                    short: true
                });

                return result;
            },

            unapproved: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Unapproved:' + data.prTitle;
                result.attachments[0].pretext = '_Pull-Request: *Unapproved*_';
                result.attachments[0].color = helper.COLORS.yellow;

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Unapproved By',
                    value: data.actor,
                    short: true
                });

                return result;
            },

            rejected: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Rejected:' + data.prTitle;
                result.attachments[0].pretext = '_Pull-Request: *Rejected*_';
                result.attachments[0].color = helper.COLORS.red;

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Rejected By',
                    value: data.actor,
                    short: true
                });

                return result;
            },

            fulfilled: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Merged:' + data.prTitle;
                result.attachments[0].pretext = '_Pull-Request: *Merged*_';
                result.attachments[0].color = helper.COLORS.green;

                result.attachments[0].fields.push({
                    title: 'Repo / Branches:',
                    value: data.repoName + ' (' + data.repoSourceName + ' → ' + data.repoDestinationName + ')',
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Merged By',
                    value: data.actor,
                    short: true
                });

                return result;
            },

            comment_created: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Comment Added:' + data.prTitle;
                result.attachments[0].pretext = '_Pull-Request: *Comment Added*_';
                result.attachments[0].title_link = data.commentUrl;
                result.attachments[0].color = helper.COLORS.green;

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Comment',
                    value: helper.truncate(data.commentContentRaw),
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Comment By',
                    value: data.actor,
                    short: true
                });


                return result;
            },

            comment_deleted: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Comment Deleted:' + data.prTitle;
                result.attachments[0].pretext = '_Pull-Request: *Comment Deleted*_';
                result.attachments[0].title_link = data.commentUrl;
                result.attachments[0].color = helper.COLORS.yellow;

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Comment',
                    value: helper.truncate(data.commentContentRaw),
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Comment By',
                    value: data.actor,
                    short: true
                });

                return result;

            },

            comment_updated: function(event) {

                var prInfo = pullrequestBaseHandler(event),
                    data = prInfo.data,
                    result = prInfo.result;

                result.attachments[0].fallback = 'Pull-Request Comment Updated:' + data.prTitle;
                result.attachments[0].pretext = 'Pull-Request: *Comment Updated*_';
                result.attachments[0].title_link = data.commentUrl;
                result.attachments[0].color = helper.COLORS.yellow;

                result.attachments[0].fields.push({
                    title: 'Author',
                    value: '@' + BITBUCKET_TO_SLACK_USERS[data.prAuthorUsername],
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Comment',
                    value: helper.truncate(data.commentContentRaw),
                    short: true
                });

                result.attachments[0].fields.push({
                    title: 'Comment By',
                    value: data.actor,
                    short: true
                });

                return result;
            }

        },

        //----------------------------------
        // Repository Event Handlers
        // See also: https://confluence.atlassian.com/bitbucket/event-payloads-740262817.html#EventPayloads-RepositoryEvents
        //-----------------------------------

        repo: {
            push: function(event) {

                var repoInfo = repoBaseHandler(event),
                    data = repoInfo.data,
                    result = repoInfo.result,
                    action = data.pushForced ? 'REBASED (attn: @dev)' : 'Pushed',
                    commitCount = data.pushCommits ? data.pushCommits.length : 0;

                result.attachments[0].fallback = data.repoName + ': ' + commitCount + ' Commits ' + action;
                result.attachments[0].pretext = '_' + data.repoName + ': *' + commitCount + ' Commits ' + action + '*_';

                result.attachments[0].fields.push({
                    title: helper.capitalize(data.pushType),
                    value: data.pushTarget,
                    short: true
                });

                result.attachments[0].fields.push({
                    title: data.pushForced ? 'Rebased By' : 'Pushed By',
                    value: data.actor,
                    short: true
                });

                if (commitCount > 0) {
                    var commitsStr = '';
                    for (var i = 0; i < commitCount; i++) {

                        var commit = data.pushCommits[i];
                        commit.message = commit.message.trim();

                        // handle bb-formatting of merge commits
                        if (commit.message.indexOf('\n\n') > -1) {
                            // replace the first newline with an indent block
                            commit.message = commit.message.replace('\n\n', '\n                     _') + '_';
                        }

                        // change to just commit.authordisplay_name if this is annoying
                        commitsStr += '(<' + commit.links.html.href + '|' + helper.truncate(commit.hash, 8, false) + '>) ' +
                            commit.message + ' - ' + commit.author.user.display_name + '\n';
                    }
                    result.attachments[0].fields.push({
                        title: 'Commits',
                        value: commitsStr.trim(),
                        short: false,
                    });
                }

                return result;
            },

        }
    };

    return messageHandlers[context][parsedKey](data);
}


//------------------------------
// Slack Submission
//------------------------------


/**
 * Properly encode and submit a normalized payload to Slack's POST endpoint.
 *
 * @param  {object} data        Slack-ready normalized payload
 * @param  {object} appContext  The Lambda context in which to invoke callbacks, etc
 */
function sendToSlack(data, appContext) {

    console.info('Sending normalized event to Slack');

    // Build the post string from an object
    var post_data = JSON.stringify(data);

    // An object of options to indicate where to post to
    var post_options = {
        host: 'hooks.slack.com',
        port: '443',
        path: slackPath,
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain',
            'Content-Length': Buffer.byteLength(post_data)
        }
    };

    // Set up the request
    var post_request = https.request(post_options, function(res) {
        var body = '';

        res.on('data', function(chunk) {
            body += chunk;
        });

        res.on('end', function() {
            appContext.succeed(body);
        });

        res.on('error', function(e) {
            appContext.fail('error:' + e.message);
        });
    });

    // post the data
    // appContext.succeed(post_data);
    post_request.write(post_data);
    post_request.end();
}


//------------------------------
// Lambda Endpoint Handler
//------------------------------

exports.handler = function(event, appContext) {
    console.info('Event received. Processing ...');
    var data = generateMessage(event.payload, event._event_key, appContext);
    sendToSlack(data, appContext);
};