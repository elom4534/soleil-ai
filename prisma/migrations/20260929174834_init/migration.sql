-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "Theme" AS ENUM ('LIGHT', 'DARK', 'SYSTEM');

-- CreateEnum
CREATE TYPE "LeagueType" AS ENUM ('LEAGUE', 'CUP', 'INTERNATIONAL');

-- CreateEnum
CREATE TYPE "MatchResult" AS ENUM ('WIN', 'DRAW', 'LOSS');

-- CreateEnum
CREATE TYPE "DataQuality" AS ENUM ('EXCELLENT', 'GOOD', 'MEDIUM', 'LOW', 'INSUFFICIENT');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'LIVE', 'IN_PLAY', 'PAUSED', 'FINISHED', 'POSTPONED', 'CANCELLED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MatchWinner" AS ENUM ('HOME_TEAM', 'AWAY_TEAM', 'DRAW');

-- CreateEnum
CREATE TYPE "PredictionStatus" AS ENUM ('GENERATED', 'PUBLISHED', 'EXPIRED', 'SETTLED');

-- CreateEnum
CREATE TYPE "MatchResultType" AS ENUM ('HOME_WIN', 'DRAW', 'AWAY_WIN');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('STARTED', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "passwordHash" TEXT,
    "image" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "UserPreferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "theme" "Theme" NOT NULL DEFAULT 'SYSTEM',
    "language" TEXT NOT NULL DEFAULT 'fr',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lome',
    "notificationsEmail" BOOLEAN NOT NULL DEFAULT true,
    "notificationsPush" BOOLEAN NOT NULL DEFAULT false,
    "favoriteLeagues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "League" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "country" TEXT NOT NULL,
    "countryCode" TEXT,
    "logo" TEXT,
    "flag" TEXT,
    "type" "LeagueType" NOT NULL DEFAULT 'LEAGUE',
    "currentSeason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dataQuality" "DataQuality" NOT NULL DEFAULT 'MEDIUM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "League_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "year" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "currentMatchday" INTEGER,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "tla" TEXT,
    "crest" TEXT,
    "founded" INTEGER,
    "venue" TEXT,
    "venueCapacity" INTEGER,
    "city" TEXT,
    "country" TEXT,
    "clubColors" TEXT,
    "website" TEXT,
    "dataQuality" "DataQuality" NOT NULL DEFAULT 'MEDIUM',
    "lastDataUpdate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "leagueId" TEXT,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamStatistics" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "matchesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "goalsFor" INTEGER NOT NULL DEFAULT 0,
    "goalsAgainst" INTEGER NOT NULL DEFAULT 0,
    "cleanSheets" INTEGER NOT NULL DEFAULT 0,
    "failedToScore" INTEGER NOT NULL DEFAULT 0,
    "homeMatchesPlayed" INTEGER NOT NULL DEFAULT 0,
    "homeWins" INTEGER NOT NULL DEFAULT 0,
    "homeDraws" INTEGER NOT NULL DEFAULT 0,
    "homeLosses" INTEGER NOT NULL DEFAULT 0,
    "homeGoalsFor" INTEGER NOT NULL DEFAULT 0,
    "homeGoalsAgainst" INTEGER NOT NULL DEFAULT 0,
    "awayMatchesPlayed" INTEGER NOT NULL DEFAULT 0,
    "awayWins" INTEGER NOT NULL DEFAULT 0,
    "awayDraws" INTEGER NOT NULL DEFAULT 0,
    "awayLosses" INTEGER NOT NULL DEFAULT 0,
    "awayGoalsFor" INTEGER NOT NULL DEFAULT 0,
    "awayGoalsAgainst" INTEGER NOT NULL DEFAULT 0,
    "xG" DOUBLE PRECISION,
    "xGA" DOUBLE PRECISION,
    "shots" INTEGER,
    "shotsOnTarget" INTEGER,
    "possession" DOUBLE PRECISION,
    "avgGoalsFor" DOUBLE PRECISION,
    "avgGoalsAgainst" DOUBLE PRECISION,
    "form" TEXT,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamStatistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamForm" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "matchDate" TIMESTAMP(3) NOT NULL,
    "isHome" BOOLEAN NOT NULL,
    "opponentId" TEXT NOT NULL,
    "result" "MatchResult" NOT NULL,
    "goalsFor" INTEGER NOT NULL,
    "goalsAgainst" INTEGER NOT NULL,
    "xG" DOUBLE PRECISION,
    "xGA" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamStrengthScore" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "attackScore" DOUBLE PRECISION NOT NULL,
    "defenseScore" DOUBLE PRECISION NOT NULL,
    "homeScore" DOUBLE PRECISION NOT NULL,
    "awayScore" DOUBLE PRECISION NOT NULL,
    "formScore" DOUBLE PRECISION NOT NULL,
    "consistencyScore" DOUBLE PRECISION NOT NULL,
    "xGScore" DOUBLE PRECISION,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamStrengthScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "utcDate" TIMESTAMP(3) NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "matchday" INTEGER,
    "stage" TEXT,
    "group" TEXT,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "halfTimeHomeScore" INTEGER,
    "halfTimeAwayScore" INTEGER,
    "winner" "MatchWinner",
    "referee" TEXT,
    "venue" TEXT,
    "dataQuality" "DataQuality" NOT NULL DEFAULT 'MEDIUM',
    "dataSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastDataUpdate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchLiveData" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "minute" INTEGER,
    "homeShots" INTEGER,
    "awayShots" INTEGER,
    "homeShotsOnTarget" INTEGER,
    "awayShotsOnTarget" INTEGER,
    "homeCorners" INTEGER,
    "awayCorners" INTEGER,
    "homeYellowCards" INTEGER,
    "awayYellowCards" INTEGER,
    "homeRedCards" INTEGER,
    "awayRedCards" INTEGER,
    "homePossession" DOUBLE PRECISION,
    "awayPossession" DOUBLE PRECISION,
    "homeXg" DOUBLE PRECISION,
    "awayXg" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchLiveData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeadToHead" (
    "id" TEXT NOT NULL,
    "teamAId" TEXT NOT NULL,
    "teamBId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "matchDate" TIMESTAMP(3) NOT NULL,
    "teamAHome" BOOLEAN NOT NULL,
    "teamAScore" INTEGER NOT NULL,
    "teamBScore" INTEGER NOT NULL,
    "competition" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HeadToHead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "status" "PredictionStatus" NOT NULL DEFAULT 'GENERATED',
    "confidenceScore" INTEGER NOT NULL,
    "dataQuality" "DataQuality" NOT NULL,
    "modelAgreement" DOUBLE PRECISION,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "actualResult" "MatchResultType",
    "isCorrect" BOOLEAN,
    "brierScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchResultPrediction" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "homeWinProb" DOUBLE PRECISION NOT NULL,
    "drawProb" DOUBLE PRECISION NOT NULL,
    "awayWinProb" DOUBLE PRECISION NOT NULL,
    "consensusPick" "MatchResultType",
    "consensusConfidence" DOUBLE PRECISION,
    "statisticalModelHome" DOUBLE PRECISION,
    "statisticalModelDraw" DOUBLE PRECISION,
    "statisticalModelAway" DOUBLE PRECISION,
    "poissonModelHome" DOUBLE PRECISION,
    "poissonModelDraw" DOUBLE PRECISION,
    "poissonModelAway" DOUBLE PRECISION,
    "xgModelHome" DOUBLE PRECISION,
    "xgModelDraw" DOUBLE PRECISION,
    "xgModelAway" DOUBLE PRECISION,
    "formModelHome" DOUBLE PRECISION,
    "formModelDraw" DOUBLE PRECISION,
    "formModelAway" DOUBLE PRECISION,
    "homeAwayModelHome" DOUBLE PRECISION,
    "homeAwayModelDraw" DOUBLE PRECISION,
    "homeAwayModelAway" DOUBLE PRECISION,
    "mlModelHome" DOUBLE PRECISION,
    "mlModelDraw" DOUBLE PRECISION,
    "mlModelAway" DOUBLE PRECISION,
    "ensembleHome" DOUBLE PRECISION,
    "ensembleDraw" DOUBLE PRECISION,
    "ensembleAway" DOUBLE PRECISION,
    "factors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchResultPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TotalGoalsPrediction" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "expectedGoals" DOUBLE PRECISION NOT NULL,
    "expectedGoalsHome" DOUBLE PRECISION,
    "expectedGoalsAway" DOUBLE PRECISION,
    "ou05Over" DOUBLE PRECISION,
    "ou05Under" DOUBLE PRECISION,
    "ou15Over" DOUBLE PRECISION,
    "ou15Under" DOUBLE PRECISION,
    "ou25Over" DOUBLE PRECISION,
    "ou25Under" DOUBLE PRECISION,
    "ou35Over" DOUBLE PRECISION,
    "ou35Under" DOUBLE PRECISION,
    "ou45Over" DOUBLE PRECISION,
    "ou45Under" DOUBLE PRECISION,
    "ou05Confidence" INTEGER,
    "ou15Confidence" INTEGER,
    "ou25Confidence" INTEGER,
    "ou35Confidence" INTEGER,
    "ou45Confidence" INTEGER,
    "goalsDistribution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TotalGoalsPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExactScorePrediction" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "topScores" JSONB NOT NULL,
    "mostLikelyScore" TEXT,
    "mostLikelyProb" DOUBLE PRECISION,
    "poissonDistribution" JSONB,
    "bivarPoissonDistribution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExactScorePrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BTTS_Prediction" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "yesProb" DOUBLE PRECISION NOT NULL,
    "noProb" DOUBLE PRECISION NOT NULL,
    "confidence" INTEGER,
    "factors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BTTS_Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HalfTimePrediction" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "ht05Over" DOUBLE PRECISION,
    "ht05Under" DOUBLE PRECISION,
    "ht15Over" DOUBLE PRECISION,
    "ht15Under" DOUBLE PRECISION,
    "ht25Over" DOUBLE PRECISION,
    "ht25Under" DOUBLE PRECISION,
    "htExpectedGoals" DOUBLE PRECISION,
    "htGoalsDist" JSONB,
    "st05Over" DOUBLE PRECISION,
    "st05Under" DOUBLE PRECISION,
    "st15Over" DOUBLE PRECISION,
    "st15Under" DOUBLE PRECISION,
    "st25Over" DOUBLE PRECISION,
    "st25Under" DOUBLE PRECISION,
    "stExpectedGoals" DOUBLE PRECISION,
    "stGoalsDist" JSONB,
    "probGoalInFirstHalf" DOUBLE PRECISION,
    "probGoalInSecondHalf" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HalfTimePrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamGoalsPrediction" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "isHome" BOOLEAN NOT NULL,
    "expectedGoals" DOUBLE PRECISION NOT NULL,
    "ou05Over" DOUBLE PRECISION,
    "ou05Under" DOUBLE PRECISION,
    "ou15Over" DOUBLE PRECISION,
    "ou15Under" DOUBLE PRECISION,
    "ou25Over" DOUBLE PRECISION,
    "ou25Under" DOUBLE PRECISION,
    "prob0Goals" DOUBLE PRECISION,
    "prob1Goal" DOUBLE PRECISION,
    "prob2Goals" DOUBLE PRECISION,
    "prob3Goals" DOUBLE PRECISION,
    "prob4PlusGoals" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamGoalsPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelOutput" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPrediction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "userPick" "MatchResultType",
    "userConfidence" INTEGER,
    "viewedAt" TIMESTAMP(3),
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UserPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelPerformance" (
    "id" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "leagueId" TEXT,
    "seasonId" TEXT,
    "dateFrom" TIMESTAMP(3) NOT NULL,
    "dateTo" TIMESTAMP(3) NOT NULL,
    "totalPredictions" INTEGER NOT NULL,
    "correctPredictions" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "brierScore" DOUBLE PRECISION NOT NULL,
    "logLoss" DOUBLE PRECISION NOT NULL,
    "calibrationData" JSONB,
    "market1x2Accuracy" DOUBLE PRECISION,
    "marketOU25Accuracy" DOUBLE PRECISION,
    "marketBTTSAccuracy" DOUBLE PRECISION,
    "marketExactAccuracy" DOUBLE PRECISION,
    "confidenceBreakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchId" TEXT,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "matchId" TEXT,
    "predictionId" TEXT,
    "modelUsed" TEXT,
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "apiBaseUrl" TEXT,
    "apiKeyName" TEXT,
    "rateLimit" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSync" TIMESTAMP(3),
    "lastError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSyncLog" (
    "id" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityCount" INTEGER NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_UserFavoriteTeams" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_UserFavoriteTeams_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "UserPreferences_userId_key" ON "UserPreferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "League_externalId_key" ON "League"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Season_leagueId_year_key" ON "Season"("leagueId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "Team_externalId_key" ON "Team"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamStatistics_teamId_seasonId_key" ON "TeamStatistics"("teamId", "seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamStrengthScore_teamId_seasonId_key" ON "TeamStrengthScore"("teamId", "seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_externalId_key" ON "Match"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchLiveData_matchId_key" ON "MatchLiveData"("matchId");

-- CreateIndex
CREATE INDEX "HeadToHead_teamAId_teamBId_idx" ON "HeadToHead"("teamAId", "teamBId");

-- CreateIndex
CREATE INDEX "Prediction_matchId_idx" ON "Prediction"("matchId");

-- CreateIndex
CREATE INDEX "Prediction_generatedAt_idx" ON "Prediction"("generatedAt");

-- CreateIndex
CREATE INDEX "Prediction_confidenceScore_idx" ON "Prediction"("confidenceScore");

-- CreateIndex
CREATE UNIQUE INDEX "MatchResultPrediction_predictionId_key" ON "MatchResultPrediction"("predictionId");

-- CreateIndex
CREATE UNIQUE INDEX "TotalGoalsPrediction_predictionId_key" ON "TotalGoalsPrediction"("predictionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExactScorePrediction_predictionId_key" ON "ExactScorePrediction"("predictionId");

-- CreateIndex
CREATE UNIQUE INDEX "BTTS_Prediction_predictionId_key" ON "BTTS_Prediction"("predictionId");

-- CreateIndex
CREATE UNIQUE INDEX "HalfTimePrediction_predictionId_key" ON "HalfTimePrediction"("predictionId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamGoalsPrediction_predictionId_teamId_key" ON "TeamGoalsPrediction"("predictionId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelOutput_predictionId_modelName_key" ON "ModelOutput"("predictionId", "modelName");

-- CreateIndex
CREATE UNIQUE INDEX "UserPrediction_userId_predictionId_key" ON "UserPrediction"("userId", "predictionId");

-- CreateIndex
CREATE INDEX "ModelPerformance_modelName_modelVersion_idx" ON "ModelPerformance"("modelName", "modelVersion");

-- CreateIndex
CREATE INDEX "ModelPerformance_leagueId_seasonId_idx" ON "ModelPerformance"("leagueId", "seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_name_key" ON "DataSource"("name");

-- CreateIndex
CREATE INDEX "DataSyncLog_dataSourceId_startedAt_idx" ON "DataSyncLog"("dataSourceId", "startedAt");

-- CreateIndex
CREATE INDEX "AdminLog_userId_createdAt_idx" ON "AdminLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminLog_entityType_entityId_idx" ON "AdminLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_key_key" ON "SystemConfig"("key");

-- CreateIndex
CREATE INDEX "_UserFavoriteTeams_B_index" ON "_UserFavoriteTeams"("B");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPreferences" ADD CONSTRAINT "UserPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStatistics" ADD CONSTRAINT "TeamStatistics_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStatistics" ADD CONSTRAINT "TeamStatistics_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamForm" ADD CONSTRAINT "TeamForm_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStrengthScore" ADD CONSTRAINT "TeamStrengthScore_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamStrengthScore" ADD CONSTRAINT "TeamStrengthScore_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchLiveData" ADD CONSTRAINT "MatchLiveData_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeadToHead" ADD CONSTRAINT "HeadToHead_teamAId_fkey" FOREIGN KEY ("teamAId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeadToHead" ADD CONSTRAINT "HeadToHead_teamBId_fkey" FOREIGN KEY ("teamBId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeadToHead" ADD CONSTRAINT "HeadToHead_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResultPrediction" ADD CONSTRAINT "MatchResultPrediction_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TotalGoalsPrediction" ADD CONSTRAINT "TotalGoalsPrediction_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExactScorePrediction" ADD CONSTRAINT "ExactScorePrediction_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BTTS_Prediction" ADD CONSTRAINT "BTTS_Prediction_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HalfTimePrediction" ADD CONSTRAINT "HalfTimePrediction_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamGoalsPrediction" ADD CONSTRAINT "TeamGoalsPrediction_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamGoalsPrediction" ADD CONSTRAINT "TeamGoalsPrediction_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelOutput" ADD CONSTRAINT "ModelOutput_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPrediction" ADD CONSTRAINT "UserPrediction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPrediction" ADD CONSTRAINT "UserPrediction_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIMessage" ADD CONSTRAINT "AIMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSyncLog" ADD CONSTRAINT "DataSyncLog_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserFavoriteTeams" ADD CONSTRAINT "_UserFavoriteTeams_A_fkey" FOREIGN KEY ("A") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserFavoriteTeams" ADD CONSTRAINT "_UserFavoriteTeams_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
