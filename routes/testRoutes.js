const express = require('express');
const router = express.Router();
const Test = require('../models/testModel');
const { isAuthenticated } = require('./middleware/authMiddleware');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');

router.post('/tests', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId; // Assuming the session contains the userId once authenticated
    const newTest = new Test({
      user_id: userId,
      name: 'New Test',
      messages: [],
      review_instructions: '',
      scenarios: []
    });
    const savedTest = await newTest.save();
    console.log(`New test created with ID: ${savedTest.test_id} by user ID: ${userId}`);
    res.redirect(`/tests/${savedTest.test_id}/`);
  } catch (error) {
    console.error('Failed to create a new test:', error.message);
    console.error(error.stack);
    res.status(500).send('Error creating a new test');
  }
});

router.get('/tests/:test_id/', isAuthenticated, async (req, res) => {
  try {
    const test = await Test.findOne({ test_id: req.params.test_id });
    if (!test) {
      return res.status(404).send('Test not found');
    }
    if (test.user_id.toString() !== req.session.userId) {
      return res.status(403).send('Unauthorized access to the test');
    }
    // Calculate the score percentages for each scenario
    const scorePercentages = test.calculateScorePercentage();
    // Attach the scorePercentages to the scenarios for rendering
    const scenariosWithPercentages = test.scenarios.map((scenario, index) => ({
      ...scenario._doc,
      scorePercentage: scorePercentages[index]
    }));
    // Create a modified test object to include score percentages
    const modifiedTest = test.toObject();
    modifiedTest.scenarios = scenariosWithPercentages;
    res.render('editTest', { test: modifiedTest });
  } catch (error) {
    console.error('Failed to fetch the test:', error.message);
    console.error(error.stack);
    res.status(500).send('Error fetching the test');
  }
});

router.post('/tests/:test_id/', isAuthenticated, async (req, res) => {
  try {
    const { name, review_instructions } = req.body;
    let messages = req.body.messages || [];
    // Ensure messages is an array of objects
    try {
      if (typeof messages === 'string') {
        messages = JSON.parse(messages);
      }
    } catch (error) {
      console.error('Error parsing messages:', error.message);
      return res.status(400).send('Invalid messages format');
    }
    const test = await Test.findOne({ test_id: req.params.test_id });
    if (!test) {
      return res.status(404).send('Test not found');
    }
    if (test.user_id.toString() !== req.session.userId) {
      return res.status(403).send('Unauthorized access to the test');
    }
    test.name = name;
    test.review_instructions = review_instructions;
    test.messages = messages;
    await test.save();
    console.log(`Test updated with ID: ${test.test_id}`);
    res.redirect(`/tests/${req.params.test_id}/`);
  } catch (error) {
    console.error('Failed to update the test:', error.message);
    console.error(error.stack);
    res.status(500).send('Error updating the test');
  }
});

router.get('/tests/:test_id/run/', isAuthenticated, async (req, res) => {
  try {
    const test = await Test.findOne({ test_id: req.params.test_id }).lean();
    if (!test) {
      return res.status(404).send('Test not found');
    }
    if (test.user_id.toString() !== req.session.userId) {
      return res.status(403).send('Unauthorized access to the test');
    }
    res.render('testRunConfig', { test, providers: ['openai', 'anthropic', 'groq'] });
  } catch (error) {
    console.error('Failed to open the test run configuration page:', error.message);
    console.error(error.stack);
    res.status(500).send('Error opening the test run configuration page');
  }
});

router.post('/tests/:test_id/run', isAuthenticated, async (req, res) => {
  try {
    const testId = req.params.test_id;
    const test = await Test.findOne({ test_id: testId });
    if (!test) return res.status(404).send('Test not found');

    const scenarios = Array.isArray(req.body.scenarios) ? req.body.scenarios : JSON.parse(req.body.scenarios);

    test.scenarios = []; // Delete any previous scenarios

    const sdks = {
      openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
      anthropic: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
      groq: new Groq({ apiKey: process.env.GROQ_API_KEY })
    };

    const scenarioPromises = scenarios.map(scenario => {
      const { provider, model, temp, n } = scenario;
      const sdk = sdks[provider];
      if (!sdk) {
        console.error(`Unsupported provider: ${provider}`);
        return Promise.resolve(null);
      }

      const testPromises = Array.from({ length: n }, () => {
        return (async () => {
          try {
            let response;
            if (provider === 'anthropic') {
              response = await sdk.messages.create({
                max_tokens: 1024,
                messages: test.messages.map(msg => ({ role: msg.role, content: msg.content })),
                model: model,
              });
            } else {
              response = await sdk.chat.completions.create({
                model: model,
                messages: test.messages.map(msg => ({ role: msg.role, content: msg.content })),
              });
            }
            return { response: extractResponseContent(response, provider), score: 1 };
          } catch (error) {
            console.error(`Error running scenario with ${provider}:`, error.message);
            console.error(error.stack);
            return null;
          }
        })();
      });

      return Promise.allSettled(testPromises).then(results => {
        return {
          provider,
          model,
          temp,
          results: results.filter(result => result.status === 'fulfilled' && result.value !== null).map(result => result.value)
        };
      });
    });

    const scenarioResults = await Promise.all(scenarioPromises);
    test.scenarios = scenarioResults.filter(scenario => scenario !== null);
    await test.save();
    console.log(`Test ${testId} run completed.`);
    res.redirect(`/tests/${testId}/`);
  } catch (error) {
    console.error('Failed to run the test:', error.message);
    console.error(error.stack);
    res.status(500).send('Error running the test');
  }
});

router.get('/tests/:test_id/scenarios/:scenario_index', isAuthenticated, async (req, res) => {
  try {
    const { test_id, scenario_index } = req.params;
    const test = await Test.findOne({ test_id: test_id });
    if (!test) return res.status(404).send('Test not found');

    if (scenario_index < 0 || scenario_index >= test.scenarios.length) {
      return res.status(404).send('Scenario not found');
    }

    const scenario = test.scenarios[scenario_index];
    res.render('scenarioDetails', { test_id, scenario, scenario_index });
  } catch (error) {
    console.error('Failed to fetch the scenario details:', error.message);
    console.error(error.stack);
    res.status(500).send('Error fetching the scenario details');
  }
});

router.post('/tests/:test_id/review', isAuthenticated, async (req, res) => {
  const testId = req.params.test_id;
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {
    const test = await Test.findOne({ test_id: testId });
    if (!test) return res.status(404).send('Test not found');

    for (const scenario of test.scenarios) {
      for (const result of scenario.results) {
        const reviewText = `Your job is to review the quality of output of an AI assistant on a specific input.\n\nThe AI assistant was asked the following:\n${test.messages.map(msg => `${msg.role}: ${msg.content}`).join('\n')}\n\nIt responded with:\n${result.response}\n\nTaking into account the instructions, please analyze its output and determine if it's close enough. If it's good enough, output "PASS". If the output wasn't good, output "FAIL".\n\nIMPORTANT: ${test.review_instructions}\n\nRemember, respond with only one word - PASS if the output is okay, FAIL otherwise.`;

        try {
          const reviewResponse = await openai.chat.completions.create({
            model: "gpt-4-turbo-preview",
            messages: [{role: "system", content: reviewText}],
            temperature: 0,
          });

          const reviewOutcome = reviewResponse.choices[0]?.message?.content.includes("PASS") ? 1 : 0;
          result.score = reviewOutcome;
        } catch (error) {
          console.error('Failed to review:', error);
          // Optionally handle the error, e.g., by setting a default score or logging
        }
      }
    }

    await test.save();
    res.redirect(`/tests/${testId}/`);
  } catch (error) {
    console.error('Error during scenario review:', error);
    res.status(500).send('Failed to review scenarios');
  }
});

function extractResponseContent(response, provider) {
  switch (provider) {
    case 'openai':
    case 'groq':
      if (response.choices && response.choices.length > 0) {
        return response.choices[0].message.content;
      }
      break;
    case 'anthropic':
      if (response.content) {
        return response.content[0].text;
      }
      break;
    default:
      console.error(`Unknown provider: ${provider}`);
  }
  return null;
}

module.exports = router;