-- CreateTable
CREATE TABLE "EmpireLogo" (
    "empireId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmpireLogo_pkey" PRIMARY KEY ("empireId")
);

-- AddForeignKey
ALTER TABLE "EmpireLogo" ADD CONSTRAINT "EmpireLogo_empireId_fkey" FOREIGN KEY ("empireId") REFERENCES "Empire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

