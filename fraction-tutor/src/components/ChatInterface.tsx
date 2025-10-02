import React, { useState, useEffect, useRef, useCallback } from 'react';
import MessageBubble from './MessageBubble';
import InputArea from './InputArea';
import ProgressIndicator from './ProgressIndicator';
import FallbackAIService from '../services/fallbackAIService';
import type { AIService } from '../services/aiService';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { progressService } from '../services/progressService';
import { sessionStorage } from '../services/sessionStorage';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import { TOPIC_IDS } from '../prompts/topicIds';
import { P6_MATH_FRACTIONS } from '../prompts/topics/P6-Math-Fractions';
import type { TopicId } from '../prompts/topics/P6-Math-Fractions';
import type { ConversationState, Message, ProblemState, EvaluatorInstruction } from '../types/types';

interface ChatInterfaceProps {
  topicId?: string;
  onBackToTopics?: () => void;
  resumeFromSession?: boolean;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
  topicId = TOPIC_IDS.P6_MATH_FRACTIONS_DIVIDING_WHOLE_NUMBERS,
  onBackToTopics,
  resumeFromSession = false
}) => {
  const { user, signInWithGoogle } = useAuth();
  const { theme } = useTheme();
  const [state, setState] = useState<ConversationState>({
    messages: [],
    currentProblemType: 1,
    sessionStats: {
      problemsAttempted: 0,
      correctAnswers: 0,
      hintsProvided: 0,
      startTime: new Date()
    },
    studentProfile: {
      strugglingWith: [],
      preferredMethod: null,
      confidenceLevel: 50
    }
  });

const [isLoading, setIsLoading] = useState(false);
  const [currentScore, setCurrentScore] = useState(0);
  const [subtopicComplete, setSubtopicComplete] = useState(false);
  const [problemsCompleted, setProblemsCompleted] = useState(0);
  const [problemState, setProblemState] = useState<ProblemState | null>(null);
  const messagesEndRef = useRef<null | HTMLDivElement>(null);
  const hasInitialized = useRef(false);

  const aiService = useRef<AIService | null>(null);
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
  const pendingNewProblemRef = useRef<{problemType: number, topicId: string} | null>(null);

  // Auto-save session state
  useSessionPersistence({
    topicId,
    conversationState: state,
    currentScore,
    problemsCompleted,
    subtopicComplete,
    problemState: problemState || undefined
  });

  useEffect(() => {
    // Prevent duplicate initialization in React StrictMode
    if (hasInitialized.current) return;

    hasInitialized.current = true;

    // Initialize AI service with fallback
    const geminiApiKey = import.meta.env.VITE_GEMINI_API_KEY;
    const claudeApiKey = import.meta.env.VITE_CLAUDE_API_KEY;

    if (!geminiApiKey) {
      console.error('Gemini API key not found in environment variables');
      return;
    }

    // Callback to show fallback messages to user
    const showFallbackMessage = (message: string) => {
      setFallbackMessage(message);
      // Clear the message after a few seconds
      setTimeout(() => setFallbackMessage(null), 3000);
    };

    aiService.current = new FallbackAIService(
      geminiApiKey,
      claudeApiKey, // optional - can be undefined
      {
        maxRetries: 1, // Fast fail - single attempt before Claude fallback
        retryDelay: 0, // No delay when switching to Claude
        exponentialBackoff: false, // No exponential backoff needed
        showFallbackMessage: true
      },
      showFallbackMessage
    );

    console.log('AI Service initialized:', {
      primary: 'Gemini',
      fallback: claudeApiKey ? 'Claude' : 'None',
      hasFallback: Boolean(claudeApiKey)
    });

    // Load previous progress if available
    loadProgress();

    // Restore from session if requested, otherwise start new conversation
    if (resumeFromSession) {
      restoreFromSession();
    } else {
      initializeConversation();
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [state.messages]);

const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Progress persistence functions
  const loadProgress = () => {
    const savedProgress = progressService.loadProgress(topicId, user?.uid);
    if (savedProgress) {
      setCurrentScore(savedProgress.score);
      setState(prev => ({
        ...prev,
        sessionStats: {
          ...prev.sessionStats,
          problemsAttempted: savedProgress.problemsAttempted,
          correctAnswers: savedProgress.correctAnswers
        },
        currentProblemType: savedProgress.currentProblemType
      }));
    }
  };

  const saveProgress = () => {
    progressService.saveProgress(
      topicId,
      state.sessionStats,
      currentScore,
      state.currentProblemType,
      user?.uid
    );
  };

  // Helper functions for problem state management
  const createNewProblemState = (problemText: string, problemType: number): ProblemState => {
    return {
      currentProblemId: `problem_${Date.now()}`,
      hintsGivenForCurrentProblem: 0,
      attemptsForCurrentProblem: 0,
      problemStartTime: new Date(),
      currentProblemText: problemText,
      problemType
    };
  };

  const updateProblemState = (instruction: EvaluatorInstruction) => {
    if (!problemState) return;

    setProblemState(prev => {
      if (!prev) return prev;

      const updated = { ...prev };

      // Increment attempts for this problem
      updated.attemptsForCurrentProblem += 1;

      // Update hints given based on instruction
      if (instruction.action === "GIVE_HINT") {
        updated.hintsGivenForCurrentProblem = instruction.hintLevel || 1;
      }

      return updated;
    });
  };

  const resetProblemState = (newProblemText: string, problemType: number) => {
    setProblemState(createNewProblemState(newProblemText, problemType));
  };

  // Callback for when step-by-step visualization completes
  const handleStepByStepComplete = useCallback(async () => {
    const pendingNewProblem = pendingNewProblemRef.current;
    if (!pendingNewProblem || !aiService.current) return;

    console.log('🎬 ChatInterface: Step-by-step complete, generating new problem');
    try {
      const newProblem = await aiService.current.generateQuestion(pendingNewProblem.problemType, pendingNewProblem.topicId);
      console.log('📝 ChatInterface: Adding new problem after step-by-step completion');

      addMessage('tutor', newProblem, { problemType: pendingNewProblem.problemType });
      resetProblemState(newProblem, pendingNewProblem.problemType);
      setState(prev => ({
        ...prev,
        sessionStats: {
          ...prev.sessionStats,
          problemsAttempted: prev.sessionStats.problemsAttempted + 1
        }
      }));

      pendingNewProblemRef.current = null;
      console.log('✅ ChatInterface: New problem added after step-by-step completion');
    } catch (error) {
      console.error('Failed to generate new problem after step-by-step completion:', error);
      pendingNewProblemRef.current = null;
    }
  }, []); // No dependencies - callback is now stable

  const restoreFromSession = async () => {
    const sessionData = sessionStorage.loadSession();
    if (!sessionData) {
      // Fallback to new conversation if session data is corrupted
      initializeConversation();
      return;
    }

    try {
      // Restore conversation state
      setState(prevState => ({
        ...prevState,
        messages: sessionData.messages,
        currentProblemType: sessionData.currentProblemType
      }));

      // Restore other state variables
      setCurrentScore(sessionData.currentScore);
      setProblemsCompleted(sessionData.problemsCompleted);
      setSubtopicComplete(sessionData.subtopicComplete);

      if (sessionData.problemState) {
        setProblemState(sessionData.problemState);
      }

      console.log('Session restored successfully');
    } catch (error) {
      console.error('Failed to restore session:', error);
      // Fallback to new conversation
      initializeConversation();
    }
  };

// Legacy function - removed as it's replaced by sequential architecture

const initializeConversation = async () => {
    if (!aiService.current) return;

    setIsLoading(true);
    try {
      // Get initial greeting and first problem in sequence
      const greeting = await aiService.current.generateInitialGreeting(topicId);
      addMessage('tutor', greeting);

      // Wait a moment for greeting to render, then add first problem
      await new Promise(resolve => setTimeout(resolve, 800));

      const firstProblem = await aiService.current.generateQuestion(1, topicId);
      addMessage('tutor', firstProblem, { problemType: 1 });

      // Initialize problem state for the first problem
      resetProblemState(firstProblem, 1);

      setState(prev => ({
        ...prev,
        sessionStats: {
          ...prev.sessionStats,
          problemsAttempted: 1
        }
      }));
    } catch (error) {
      console.error('Failed to initialize conversation:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const addMessage = (
    role: 'tutor' | 'student',
    content: string,
    metadata?: Message['metadata'],
    visualization?: import('../types/visualization').VisualizationData
  ) => {
    // Prevent empty messages from being added
    if (!content || !content.trim()) {
      console.warn('Attempted to add empty message, skipping');
      return;
    }

    const newMessage: Message = {
      id: Date.now().toString(),
      role,
      content: content.trim(),
      timestamp: new Date(),
      metadata,
      visualization
    };

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, newMessage]
    }));
  };

const handleStudentSubmit = async (input: string) => {
    if (!aiService.current || !input.trim() || !problemState) return;

    // Add student message
    addMessage('student', input);
    setIsLoading(true);

    try {
      // Check if subtopic is already complete
      if (subtopicComplete || currentScore >= 1.0) {
        console.log('Subtopic already complete, generating celebration message');

        const sessionDuration = Math.round(
          (new Date().getTime() - state.sessionStats.startTime.getTime()) / 60000
        );

        const celebration = await aiService.current.generateCelebration(
          currentScore,
          problemsCompleted,
          sessionDuration,
          topicId
        );

        addMessage('tutor', celebration);
        return;
      }

      // Get recent conversation history
      const recentHistory = state.messages.slice(-6);

      console.log('=== SEQUENTIAL AGENT FLOW START ===');
      console.log('Problem State:', problemState);
      console.log('Student Response:', input);

      // STEP 1: Evaluator Agent - Analyze and provide instruction
      const instruction = await aiService.current.evaluateAndInstruct(
        input,
        recentHistory,
        problemState,
        topicId
      );

      console.log('Evaluator instruction:', instruction);

      // STEP 2: Update explicit state based on instruction
      updateProblemState(instruction);

      // Update score from instruction
      const newScore = currentScore + instruction.pointsEarned;
      setCurrentScore(newScore);

      // Override instruction if subtopic is completed
      if (newScore >= 1.0 && instruction.action === "NEW_PROBLEM") {
        instruction.action = "CELEBRATE";
      }

      if (instruction.isMainProblemSolved) {
        const newProblemsCompleted = problemsCompleted + 1;
        setProblemsCompleted(newProblemsCompleted);

        setState(prev => ({
          ...prev,
          sessionStats: {
            ...prev.sessionStats,
            correctAnswers: newProblemsCompleted
          }
        }));
      }

// Check for subtopic completion
      if (newScore >= 1.0) {
        setSubtopicComplete(true);
        console.log('🎉 SUBTOPIC COMPLETED! Score:', newScore.toFixed(2));
      }

      // STEP 3: Calculate problem type for NEW_PROBLEM actions BEFORE execution
      let problemTypeForExecution = state.currentProblemType;
      if (instruction.action === "NEW_PROBLEM") {
        // Get topic config to determine next problem type
        const topicConfig = P6_MATH_FRACTIONS[topicId as TopicId];
        const thresholds = topicConfig.PROBLEM_TYPE_CONFIG.progressionThresholds;

        // Calculate next problem type based on new score
        let nextProblemType = 1;
        for (let i = 0; i < thresholds.length; i++) {
          if (newScore >= thresholds[i]) {
            nextProblemType = i + 2;
          }
        }

        problemTypeForExecution = nextProblemType;

        // Update state with new problem type immediately
        if (nextProblemType !== state.currentProblemType) {
          setState(prev => ({
            ...prev,
            currentProblemType: nextProblemType
          }));
        }
      }

      // STEP 3.5: Check topic config to override visualization setting
      // This allows topic-specific control over visualization based on problem type
      if (instruction.action === "GIVE_SOLUTION" && instruction.includeVisualization) {
        const topicConfig = P6_MATH_FRACTIONS[topicId as TopicId];
        if (topicConfig && 'STEP_VISUALIZATION_CONFIG' in topicConfig) {
          const stepConfigs = (topicConfig as any).STEP_VISUALIZATION_CONFIG[problemTypeForExecution];
          if (stepConfigs && Array.isArray(stepConfigs) && stepConfigs.length > 0) {
            // Check if any step has visualization enabled
            const hasVisualization = stepConfigs.some((step: any) => step.includeVisualization === true);
            if (!hasVisualization) {
              // Override evaluator's decision - no visualization for this problem type
              instruction.includeVisualization = false;
              console.log(`🚫 Visualization disabled for problem type ${problemTypeForExecution} per topic config`);
            }
          }
        }
      }

      // STEP 4: Generate response based on action
      let tutorResponse: string;
      let structuredVisualizationData = undefined;

      if (instruction.action === "GIVE_SOLUTION" && instruction.includeVisualization && problemState?.currentProblemText) {
        // NEW FLOW: Use Visualization Agent for solutions
        // Single LLM call generates: solution text + complete visualization data
        console.log('🎨 Using Visualization Agent for solution (1 LLM call)');
        try {
          structuredVisualizationData = await aiService.current.generateVisualizationSolution(
            problemState.currentProblemText,
            problemTypeForExecution,
            topicId,
            recentHistory,
            input,
            instruction.reasoning || 'Student needs help with this problem'
          );
          console.log('Visualization Agent data:', structuredVisualizationData);

          // Extract tutor response from structured data
          if (structuredVisualizationData) {
            // Construct the tutor response text from introText
            tutorResponse = structuredVisualizationData.introText || "Let me show you how to solve this.";
          } else {
            console.warn('Visualization Agent returned null, using fallback');
            tutorResponse = "Let me show you how to solve this problem step by step.";
          }
        } catch (error) {
          console.error('Failed to generate visualization solution:', error);
          tutorResponse = "Let me show you how to solve this problem step by step.";
          structuredVisualizationData = undefined;
        }
      } else {
        // OLD FLOW: Use Tutor Agent for hints, new problems, celebrations
        console.log('📝 Using Tutor Agent for:', instruction.action);
        tutorResponse = await aiService.current.executeInstruction(
          instruction,
          recentHistory,
          input,
          problemTypeForExecution,
          topicId
        );
        console.log('Tutor response:', tutorResponse);
      }

      // STEP 5: Prepare for new problem generation (no re-render with ref)
      if (instruction.action === "GIVE_SOLUTION" && structuredVisualizationData) {
        console.log('🎬 ChatInterface: Setting up step-by-step completion callback');
        // Store the pending new problem details in ref (no re-render)
        pendingNewProblemRef.current = { problemType: problemTypeForExecution, topicId };
      }

      // STEP 6: Add tutor response with visualization data
      console.log('🏃 ChatInterface: Adding message to chat');
      addMessage('tutor', tutorResponse, { problemType: problemTypeForExecution }, structuredVisualizationData);
      console.log('✅ ChatInterface: Message added');

      // If instruction was to give a new problem, reset problem state with correct problem type
      if (instruction.action === "NEW_PROBLEM") {
        resetProblemState(tutorResponse, problemTypeForExecution);
      }

      // STEP 7: Auto-generate new problem after GIVE_SOLUTION - only if no visualization
      if (instruction.action === "GIVE_SOLUTION" && !structuredVisualizationData) {
        console.log('🔄 ChatInterface: Generating new problem after solution (no visualization)');
        // Generate a new problem at the current problem type immediately
        const newProblem = await aiService.current.generateQuestion(problemTypeForExecution, topicId);
        console.log('📝 ChatInterface: Adding new problem message to chat');
        addMessage('tutor', newProblem, { problemType: problemTypeForExecution });
        console.log('✅ ChatInterface: New problem message added');

        // Reset problem state for the new problem
        resetProblemState(newProblem, problemTypeForExecution);

        // Increment problems attempted counter
        setState(prev => ({
          ...prev,
          sessionStats: {
            ...prev.sessionStats,
            problemsAttempted: prev.sessionStats.problemsAttempted + 1
          }
        }));
      }

      console.log('=== SEQUENTIAL AGENT FLOW COMPLETE ===');
      console.log('Final state - Score:', newScore.toFixed(2), 'Problems:', instruction.isMainProblemSolved ? problemsCompleted + 1 : problemsCompleted);

    } catch (error) {
      console.error('Failed to process sequential agent flow:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Get current topic configuration for display
  const currentTopicConfig = P6_MATH_FRACTIONS[topicId as TopicId];
  const topicDisplayName = currentTopicConfig?.displayName || 'Fraction Division';

  return (
    <div
      className="flex flex-col h-full scroll-smooth"
      style={{
        backgroundColor: theme.colors.chat,
        color: theme.colors.textPrimary,
      }}
    >
      {/* Header with topic info and progress */}
      <div
        className="flex items-center justify-between px-6 py-4 border-b"
        style={{
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.chat,
        }}
      >
        <div className="flex items-center space-x-3">
          {/* Back Button */}
          {onBackToTopics && (
            <button
              onClick={onBackToTopics}
              className="w-8 h-8 rounded-full flex items-center justify-center transition-colors focus:outline-none focus:ring-2"
              style={{
                backgroundColor: theme.colors.interactive,
                color: theme.colors.textSecondary,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = theme.colors.brand;
                e.currentTarget.style.color = '#ffffff';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = theme.colors.interactive;
                e.currentTarget.style.color = theme.colors.textSecondary;
              }}
              title="Back to topic selection"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}

          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-lg text-white"
            style={{ backgroundColor: theme.colors.brand }}
          >
            ➗
          </div>
          <div>
            <h1 className="text-lg font-semibold" style={{ color: theme.colors.textPrimary }}>
              {topicDisplayName}
            </h1>
            <p className="text-sm" style={{ color: theme.colors.textMuted }}>Master fractions step by step!</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <ProgressIndicator stats={state.sessionStats} currentScore={currentScore} />

          {/* Auth Button */}
          {user ? (
            <div className="flex items-center space-x-3">
              <img
                src={user.photoURL || undefined}
                alt={user.displayName || 'User'}
                className="w-7 h-7 rounded-full"
                style={{ backgroundColor: theme.colors.interactive }}
              />
              <button
                onClick={() => {/* Add logout logic if needed */}}
                className="text-sm hover:underline"
                style={{ color: theme.colors.textSecondary }}
                title="Signed in"
              >
                {user.displayName?.split(' ')[0] || 'User'}
              </button>
            </div>
          ) : (
            <button
              onClick={async () => {
                try {
                  await signInWithGoogle();
                } catch (error) {
                  console.error('Sign-in failed:', error);
                }
              }}
              className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2"
              style={{
                backgroundColor: theme.colors.brand,
                color: '#ffffff',
              }}
            >
              Sign In
            </button>
          )}
        </div>
      </div>

      {/* Chat Messages */}
      <div
        className="overflow-y-auto"
        style={{ height: 0, flexGrow: 1 }}
      >
        <div className="w-full mx-auto p-6 space-y-6">
          {state.messages.map(message => {
            // Only pass the callback to messages that have step-by-step visualization
            const hasStepByStepVisualization = message.visualization &&
              typeof message.visualization === 'object' &&
              Array.isArray(message.visualization.steps) &&
              message.visualization.steps.length > 0;

            return (
              <MessageBubble
                key={message.id}
                message={message}
                problemText={problemState?.currentProblemText}
                topicId={topicId}
                onStepByStepComplete={hasStepByStepVisualization ? handleStepByStepComplete : undefined}
              />
            );
          })}
          {isLoading && (
            <div className="flex items-start space-x-3 justify-start">
              {/* Tutor Avatar */}
              <div
                className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-lg text-white shadow-md"
                style={{ backgroundColor: theme.colors.brand }}
              >
                📚
              </div>

              {/* Loading Message */}
              <div
                className="relative rounded-2xl px-5 py-4 shadow-sm max-w-lg border"
                style={{
                  backgroundColor: theme.colors.tutorMessage,
                  borderColor: theme.colors.border,
                  color: theme.colors.textPrimary,
                }}
              >
                {/* Message tail */}
                <div
                  className="absolute top-4 w-3 h-3 transform rotate-45 border-l border-t -left-1.5"
                  style={{
                    backgroundColor: theme.colors.tutorMessage,
                    borderColor: theme.colors.border,
                  }}
                />

                <div className="text-xs font-semibold mb-2" style={{ color: theme.colors.textAccent }}>
                  Math Tutor
                </div>

                <div className="flex items-center space-x-2">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: theme.colors.brand }} />
                    <div className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: theme.colors.brand, animationDelay: '0.1s' }} />
                    <div className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: theme.colors.brand, animationDelay: '0.2s' }} />
                  </div>
                  <span className="text-sm ml-2" style={{ color: theme.colors.textMuted }}>
                    {fallbackMessage || 'Thinking...'}
                  </span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <InputArea onSubmit={handleStudentSubmit} disabled={isLoading} />
    </div>
  );
};

export default ChatInterface;